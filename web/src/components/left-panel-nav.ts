/**
 * Left-panel navigation tree — pure, testable derivation of the unified
 * sidebar (Codex-style: project directories with chats nested under each).
 *
 * Kept side-effect free so the grouping/nesting/order rules can be unit-tested
 * without a DOM. The component only renders whatever this returns.
 */
import type { ConversationSummary, ProjectSummary, SessionSummary, WorktreeSummary } from "../types";

/** A running conversation row (depth kept for the nested-row layout). */
export interface NavConversation {
	c: ConversationSummary;
	depth: number;
	/** The linked worktree the chat runs in (undefined in the main checkout
	 *  or outside git) — drives the branch badge and the remove action. */
	worktree?: WorktreeSummary;
}

/** One top-level navigation group (a workspace directory). */
export interface NavGroup {
	/** Absolute workspace directory this group represents. */
	path: string;
	/** Directory basename for display. */
	label: string;
	/** True when the path is a known recent project (delete affordance shown). */
	isProject: boolean;
	/** True when this group is the active working directory. */
	isCurrent: boolean;
	/** Sort key: project last-used epoch ms; ungrouped chats = 0. */
	lastUsed: number;
	/** Running conversations under this group. */
	conversations: NavConversation[];
	/** History sessions under this group, matched by the group's cwd — for a
	 *  repository, by ANY of its checkouts (merged, newest first). */
	sessions: SessionSummary[];
	/** Linked worktree per history session path (folded), for sessions that
	 *  live in one. Absent for main-checkout sessions. */
	sessionWorktrees: ReadonlyMap<string, WorktreeSummary>;
	/** Every checkout of the project's repository, main first; [] outside git. */
	worktrees: WorktreeSummary[];
	/** Directories whose history this group shows and that are NOT the active
	 *  cwd (whose listing arrives through the unscoped `list_sessions`). Main
	 *  checkout first, then linked worktrees. */
	fetchCwds: string[];
}

/** Directory basename, tolerant of trailing and mixed separators. */
export function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	if (!trimmed) return path; // all separators (e.g. "/") — return as-is
	const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Grouping key for a workspace path. Windows drive paths are case-insensitive
 * (`c:\Users\me\x` and `C:\Users\me\X` are one directory, and pi sessions
 * exist under both spellings), so they fold to lower case; POSIX paths stay
 * exact.
 */
export function cwdKey(path: string): string {
	return /^[A-Za-z]:[\\/]/.test(path) ? path.toLowerCase() : path;
}

/** Running conversations in list order, all at root depth. */
export function flattenConversations(list: ConversationSummary[]): NavConversation[] {
	return list.map((c) => ({ c, depth: 0 }));
}

/** Badge text for a linked worktree: its branch, else the short HEAD. */
export function worktreeLabel(w: WorktreeSummary): string {
	return w.branch ?? w.head;
}

function makeGroup(
	path: string,
	isProject: boolean,
	lastUsed: number,
	worktrees: WorktreeSummary[],
	convsByKey: Map<string, ConversationSummary[]>,
	sessionsByKey: ReadonlyMap<string, SessionSummary[]>,
	currentCwd: string,
): NavGroup {
	const currentKey = cwdKey(currentCwd);
	// Chats in a linked worktree are matched by that checkout's cwd; the
	// badge names its branch so two chats of one repo read as different work.
	const cwds = worktrees.length > 0 ? worktrees.map((w) => w.path) : [path];
	const linkedByKey = new Map<string, WorktreeSummary>();
	for (const w of worktrees) if (!w.isMain) linkedByKey.set(cwdKey(w.path), w);
	const conversations: NavConversation[] = [];
	const sessions: SessionSummary[] = [];
	const sessionWorktrees = new Map<string, WorktreeSummary>();
	const seenSessions = new Set<string>();
	let isCurrent = false;
	for (const cwd of cwds) {
		const k = cwdKey(cwd);
		if (k === currentKey) isCurrent = true;
		const worktree = linkedByKey.get(k);
		for (const c of convsByKey.get(k) ?? []) conversations.push(worktree ? { c, depth: 0, worktree } : { c, depth: 0 });
		for (const s of sessionsByKey.get(k) ?? []) {
			const pk = cwdKey(s.path);
			if (seenSessions.has(pk)) continue;
			seenSessions.add(pk);
			sessions.push(s);
			if (worktree) sessionWorktrees.set(pk, worktree);
		}
	}
	sessions.sort((a, b) => b.modified - a.modified);
	return {
		path,
		label: basename(path),
		isProject,
		isCurrent,
		lastUsed,
		conversations,
		sessions,
		sessionWorktrees,
		worktrees,
		fetchCwds: cwds.filter((cwd) => cwdKey(cwd) !== currentKey),
	};
}

/**
 * Build the unified sidebar tree:
 *
 * - Every known recent project becomes a top-level directory group.
 * - Running conversations are nested under the group matching their workspace
 *   cwd.
 * - Running conversations whose cwd is not a known project are kept as
 *   "ungrouped" groups (one per cwd) so they are never silently dropped.
 * - History sessions are attached to the group matching their cwd: the server
 *   echoes each `sessions` push with its queried cwd, so the left panel can
 *   load any project's history on expand without switching the active chat.
 *
 * Order: known projects by last-used desc, then ungrouped cwds by label asc
 * (the panel then pins that order for the session - see stableProjectOrder).
 */
/**
 * Which project groups currently need a scoped `list_sessions { cwd }`
 * request. Pure so the lazy-history lifecycle is unit-testable without a DOM.
 *
 * The panel renders every group expanded by default (collapsing is opt-in), so
 * "request the first time the user expands it" is wrong: an initially expanded
 * non-current project, and a project that only appears after `list_projects`,
 * would stay empty. The caller drives this from an effect over the visible
 * groups instead.
 *
 * A group is pending when ALL hold:
 *  - the directory is not the current cwd — the mount/reconnect effect lists
 *    the active cwd separately with an unscoped `list_sessions` (whose reply
 *    is echoed with the active cwd), so requesting it again here would only
 *    duplicate. A repository group asks for each of its OTHER checkouts
 *    (`fetchCwds`), so a project's worktree chats load alongside its own;
 *  - it is expanded (`collapsed` holds only the user-collapsed paths);
 *  - it has no request currently in flight (avoids request storms while the
 *    reply is on the wire);
 *  - it has not already loaded successfully (`loaded` = cwds the server has
 *    echoed a `sessions` reply for), unless `refresh` forces a re-fetch — the
 *    reconnect path uses that because a cached list may be stale.
 *
 * Returned in nav order; the caller sends one request per path.
 */
export function pendingSessionCwds(
	groups: readonly NavGroup[],
	collapsed: ReadonlySet<string>,
	loaded: ReadonlySet<string>,
	inFlight: ReadonlySet<string>,
	refresh = false,
): string[] {
	const out: string[] = [];
	for (const g of groups) {
		if (!g.isProject) continue; // detached chats are pushed by the server unprompted
		if (collapsed.has(g.path)) continue;
		for (const cwd of g.fetchCwds) {
			if (inFlight.has(cwd)) continue;
			if (!refresh && loaded.has(cwd)) continue;
			out.push(cwd);
		}
	}
	return out;
}

export function buildLeftNav(
	projects: ProjectSummary[],
	conversations: ConversationSummary[],
	sessionsByCwd: ReadonlyMap<string, SessionSummary[]>,
	currentCwd: string,
): NavGroup[] {
	// Everything is matched by folded key so case variants of one directory
	// land in one group; the group keeps the first spelling it saw.
	const convsByKey = new Map<string, ConversationSummary[]>();
	const spelling = new Map<string, string>();
	for (const c of conversations) {
		const key = cwdKey(c.cwd);
		const arr = convsByKey.get(key) ?? [];
		arr.push(c);
		convsByKey.set(key, arr);
		if (!spelling.has(key)) spelling.set(key, c.cwd);
	}
	// Two spellings of one cwd can each have been listed; the files are the
	// same, so dedupe by folded transcript path.
	const sessionsByKey = new Map<string, SessionSummary[]>();
	for (const [cwd, list] of sessionsByCwd) {
		const key = cwdKey(cwd);
		const merged = sessionsByKey.get(key) ?? [];
		const seen = new Set(merged.map((s) => cwdKey(s.path)));
		for (const s of list) {
			const pk = cwdKey(s.path);
			if (seen.has(pk)) continue;
			seen.add(pk);
			merged.push(s);
		}
		merged.sort((a, b) => b.modified - a.modified);
		sessionsByKey.set(key, merged);
		if (!spelling.has(key)) spelling.set(key, cwd);
	}

	// A running conversation is the live view of its transcript file — don't
	// list that file again as history.
	const liveFiles = new Set<string>();
	for (const c of conversations) if (c.sessionPath) liveFiles.add(cwdKey(c.sessionPath));
	if (liveFiles.size > 0) {
		for (const [key, list] of sessionsByKey) {
			sessionsByKey.set(
				key,
				list.filter((s) => !liveFiles.has(cwdKey(s.path))),
			);
		}
	}

	// A project claims its main checkout AND every linked worktree.
	const known = new Set<string>();
	const groups: NavGroup[] = [];

	for (const p of projects) {
		const worktrees = p.worktrees ?? [];
		known.add(cwdKey(p.path));
		for (const w of worktrees) known.add(cwdKey(w.path));
		groups.push(makeGroup(p.path, true, p.lastUsed, worktrees, convsByKey, sessionsByKey, currentCwd));
	}

	const ungroupedKeys = [...new Set([...convsByKey.keys(), ...sessionsByKey.keys()])]
		.filter((key) => !known.has(key))
		.sort();
	for (const key of ungroupedKeys) {
		groups.push(makeGroup(spelling.get(key) ?? key, false, 0, [], convsByKey, sessionsByKey, currentCwd));
	}

	groups.sort((a, b) => {
		if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
		if (a.isProject) return b.lastUsed - a.lastUsed;
		return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
	});
	disambiguateLabels(groups);
	return groups;
}

/**
 * Keep project rows where the user last saw them. `lastUsed` bumps on every
 * switch, so sorting by it alone makes the project you just clicked leap to
 * the top; instead the first order seen this session is remembered and only
 * genuinely new projects are inserted (at the top). `order` is mutated.
 */
export function stableProjectOrder(groups: NavGroup[], order: string[]): NavGroup[] {
	const projects = groups.filter((g) => g.isProject);
	const rest = groups.filter((g) => !g.isProject);
	const present = new Set(projects.map((g) => cwdKey(g.path)));
	const kept = order.filter((k) => present.has(k));
	const fresh = projects.map((g) => cwdKey(g.path)).filter((k) => !kept.includes(k));
	order.splice(0, order.length, ...fresh, ...kept);
	const index = new Map(order.map((k, i) => [k, i]));
	projects.sort((a, b) => (index.get(cwdKey(a.path)) ?? 0) - (index.get(cwdKey(b.path)) ?? 0));
	return [...projects, ...rest];
}

/** Path segments, tolerant of mixed separators, root-first. */
function segments(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Two workspaces can share a basename (a worktree checkout next to the main
 * repo, "PiAstra" in two parent folders). Showing both as "PiAstra" reads as a
 * duplicate bug, so colliding project labels grow the nearest distinguishing
 * parent: "4cb0/PiAstra" vs "Personal/PiAstra". Non-colliding labels are
 * untouched. Mutates in place.
 */
export function disambiguateLabels(groups: NavGroup[]): void {
	const byLabel = new Map<string, NavGroup[]>();
	for (const g of groups) {
		if (!g.isProject) continue;
		const arr = byLabel.get(g.label) ?? [];
		arr.push(g);
		byLabel.set(g.label, arr);
	}
	for (const same of byLabel.values()) {
		if (same.length < 2) continue;
		const segs = same.map((g) => segments(g.path));
		// grow the suffix until every label in the set is unique (or paths run out)
		for (let depth = 2; ; depth++) {
			const labels = segs.map((s) => s.slice(-depth).join("/"));
			const unique = new Set(labels).size === labels.length;
			const exhausted = segs.every((s) => s.length <= depth);
			if (unique || exhausted) {
				same.forEach((g, i) => {
					g.label = labels[i];
				});
				break;
			}
		}
	}
}
