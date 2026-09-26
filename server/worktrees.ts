/**
 * Git worktree discovery for the project sidebar.
 *
 * A worktree is a second checkout of one repository, so it must nest under
 * the repository's main checkout in the sidebar instead of showing up as an
 * unrelated project. Everything here is read-only plumbing around
 * `git worktree list --porcelain`; the parser, slug and managed-path rules
 * mirror PiAstra's CLI extension (`extensions/pi-worktree/git-worktree.ts`)
 * so worktrees created from either side look the same to both.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;

export interface GitWorktree {
	/** Absolute checkout path, normalized with `path.resolve`. */
	path: string;
	head: string;
	/** Branch name without `refs/heads/`; null when detached. */
	branch: string | null;
	bare: boolean;
	locked: boolean;
	/** Git can no longer find the checkout directory. */
	prunable: boolean;
}

/** Parse `git worktree list --porcelain`. The first entry is the main checkout. */
export function parseWorktrees(porcelain: string): GitWorktree[] {
	const items: GitWorktree[] = [];
	let current: Partial<GitWorktree> | null = null;

	const push = () => {
		if (current?.path) {
			items.push({
				path: resolve(current.path),
				head: current.head ?? "",
				branch: current.branch ?? null,
				bare: current.bare ?? false,
				locked: current.locked ?? false,
				prunable: current.prunable ?? false,
			});
		}
		current = null;
	};

	for (const line of porcelain.split("\n")) {
		if (line.length === 0) {
			push();
			continue;
		}
		if (line.startsWith("worktree ")) {
			push();
			current = { path: line.slice("worktree ".length) };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length);
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line === "detached") current.branch = null;
		else if (line === "bare") current.bare = true;
		else if (line.startsWith("locked")) current.locked = true;
		else if (line.startsWith("prunable")) current.prunable = true;
	}
	push();
	return items;
}

/** Every checkout of the repository containing `dir`; [] outside a repo or on
 *  any git failure (missing git, timeout, dubious ownership …). */
export async function listWorktrees(dir: string): Promise<GitWorktree[]> {
	try {
		const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
			cwd: dir,
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 1024 * 1024,
		});
		return parseWorktrees(stdout);
	} catch {
		return [];
	}
}

function slugHash(value: string): string {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function isWindowsReservedName(slug: string): boolean {
	const stem = slug.split(".", 1)[0].toLowerCase();
	return ["con", "prn", "aux", "nul"].includes(stem) || /^(com|lpt)[1-9]$/.test(stem);
}

/** Directory name for a branch: `feat/login` → `feat-login`. Same rule as the CLI. */
export function branchSlug(branch: string): string {
	const name = branch.replace(/^refs\/heads\//, "");
	const slug = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	if (slug && !isWindowsReservedName(slug)) return slug;
	return `branch-${slugHash(name)}`;
}

/** Root of the managed worktree layout shared with the CLI. */
export function managedWorktreesRoot(home = homedir()): string {
	return join(home, ".pi", "worktrees");
}

/** Managed worktree path for a branch: `~/.pi/worktrees/<repo>/<slug>`. */
export function resolveWorktreePath(mainPath: string, branch: string, home = homedir()): string {
	return join(managedWorktreesRoot(home), basename(mainPath), branchSlug(branch));
}

function pathKey(p: string): string {
	const r = resolve(p);
	return process.platform === "win32" ? r.toLowerCase() : r;
}

/** True when `path` lives under the managed `~/.pi/worktrees` layout. */
export function isManagedWorktree(path: string, home = homedir()): boolean {
	const root = pathKey(managedWorktreesRoot(home));
	const key = pathKey(path);
	return key.startsWith(root + "\\") || key.startsWith(root + "/");
}

/** Same checkout regardless of separator/case differences. */
export function sameWorktreePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

// ---------------------------------------------------------------------------
// Mutations — the same git sequences the CLI's /worktree add|rm run.
// ---------------------------------------------------------------------------

/** Thrown by createWorktree / removeWorktree with a user-readable message. */
export class WorktreeError extends Error {
	constructor(
		message: string,
		/** The target has uncommitted changes and removal needs `force`. */
		readonly dirty = false,
	) {
		super(message);
		this.name = "WorktreeError";
	}
}

const MUTATION_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
	try {
		const { stdout } = await exec("git", args, {
			cwd,
			timeout,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (err) {
		const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
		const detail = (e.stderr || e.stdout || e.message || "").trim();
		throw new WorktreeError(e.killed ? `git ${args[0]} timed out` : detail || `git ${args[0]} failed`);
	}
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
	try {
		await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

async function detectDefaultBranch(cwd: string): Promise<string> {
	try {
		const head = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const m = head.match(/refs\/remotes\/origin\/(.+)$/);
		if (m?.[1]) return m[1];
	} catch {
		/* no origin/HEAD */
	}
	for (const candidate of ["main", "master"]) {
		if (await refExists(cwd, `refs/heads/${candidate}`)) return candidate;
		if (await refExists(cwd, `refs/remotes/origin/${candidate}`)) return candidate;
	}
	return "main";
}

/** Git branch-name rules that matter for a typed name (see git-check-ref-format). */
export function validBranchName(name: string): boolean {
	if (!name || name.length > 200) return false;
	if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
	if (name.endsWith(".lock") || name.includes("..") || name.includes("//") || name.includes("@{")) return false;
	// eslint-disable-next-line no-control-regex
	return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
}

const NAME_ADJECTIVES = [
	"bright",
	"calm",
	"clever",
	"eager",
	"gentle",
	"keen",
	"lucky",
	"merry",
	"nimble",
	"quiet",
	"rapid",
	"sunny",
	"swift",
	"tidy",
	"vivid",
	"witty",
	"bold",
	"brisk",
	"crisp",
	"fresh",
];
const NAME_NOUNS = [
	"fox",
	"otter",
	"heron",
	"lynx",
	"finch",
	"maple",
	"cedar",
	"river",
	"comet",
	"ember",
	"harbor",
	"meadow",
	"pebble",
	"quill",
	"summit",
	"willow",
	"beacon",
	"canyon",
	"delta",
	"orbit",
];

/** A readable branch name for a worktree nobody named: `bright-fox`. */
export function generateWorktreeName(random: () => number = Math.random): string {
	const pick = (list: string[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
	return `${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`;
}

export interface CreatedWorktree {
	path: string;
	branch: string;
	/** An existing checkout of that branch was reused instead of creating one. */
	existed: boolean;
}

/**
 * Check `branch` out as a linked worktree of the repository containing `dir`
 * under the managed layout and return its path. An existing checkout of the
 * branch is reused. A local branch is reused as-is; a remote-only branch is
 * tracked; an unknown branch is created from `origin/<default>` (fetched
 * first) or the local default branch.
 */
export async function createWorktree(dir: string, branch: string, home = homedir()): Promise<CreatedWorktree> {
	if (!validBranchName(branch)) throw new WorktreeError(`"${branch}" is not a valid branch name`);
	const worktrees = await listWorktrees(dir);
	if (worktrees.length === 0) throw new WorktreeError("Not inside a git repository");
	const main = worktrees[0].path;

	const existing = worktrees.find((w) => w.branch === branch);
	if (existing) return { path: existing.path, branch, existed: true };

	const path = resolveWorktreePath(main, branch, home);
	const taken = worktrees.find((w) => sameWorktreePath(w.path, path));
	if (taken) {
		throw new WorktreeError(`${path} is already used by the worktree for ${taken.branch ?? "a detached HEAD"}`);
	}

	const localRef = `refs/heads/${branch}`;
	const remoteRef = `refs/remotes/origin/${branch}`;
	let hasLocal = await refExists(main, localRef);
	let hasRemote = await refExists(main, remoteRef);
	if (!hasLocal) {
		// Refresh the remote tip in case the branch exists only upstream.
		try {
			await git(main, ["fetch", "origin", branch], MUTATION_TIMEOUT_MS);
		} catch {
			/* offline or unknown upstream branch — decided below */
		}
		hasLocal = await refExists(main, localRef);
		hasRemote = await refExists(main, remoteRef);
	}

	if (hasLocal) {
		await git(main, ["worktree", "add", path, branch], MUTATION_TIMEOUT_MS);
	} else if (hasRemote) {
		await git(main, ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], MUTATION_TIMEOUT_MS);
	} else {
		const base = await detectDefaultBranch(main);
		let start = base;
		if (await refExists(main, `refs/remotes/origin/${base}`)) {
			start = `origin/${base}`;
			try {
				await git(main, ["fetch", "origin", base], MUTATION_TIMEOUT_MS);
			} catch {
				/* use the cached remote tip */
			}
		}
		// --no-track: a branch cut from origin/main must not inherit origin/main
		// as its upstream, or a later `git push` would aim at main.
		await git(main, ["worktree", "add", "--no-track", "-b", branch, path, start], MUTATION_TIMEOUT_MS);
	}
	return { path, branch, existed: false };
}

/** True when the checkout has uncommitted or untracked changes. */
export async function worktreeIsDirty(path: string): Promise<boolean> {
	return (await git(path, ["status", "--porcelain", "--untracked-files=all"])).length > 0;
}

/**
 * Remove a linked worktree directory; the branch is kept. Refuses the main
 * checkout and a locked worktree. A dirty worktree throws `WorktreeError`
 * with `dirty` set unless `force` is given.
 */
export async function removeWorktree(path: string, force = false): Promise<GitWorktree> {
	const worktrees = await listWorktrees(path);
	if (worktrees.length === 0) throw new WorktreeError("Not inside a git repository");
	const main = worktrees[0];
	const target = worktrees.find((w) => sameWorktreePath(w.path, path));
	if (!target) throw new WorktreeError(`${path} is not a worktree of this repository`);
	if (sameWorktreePath(target.path, main.path)) throw new WorktreeError("Refusing to remove the main checkout");
	if (target.locked) throw new WorktreeError(`Worktree is locked: ${target.path}`);
	if (!force && (await worktreeIsDirty(target.path))) {
		throw new WorktreeError(`${target.branch ?? target.path} has uncommitted changes`, true);
	}
	const args = force ? ["worktree", "remove", "--force", target.path] : ["worktree", "remove", target.path];
	await git(main.path, args, MUTATION_TIMEOUT_MS);
	return target;
}
