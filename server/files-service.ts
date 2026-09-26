/**
 * Files service — 从 agent-service.ts 抽出（文件树列目录 / 预览读写 / 路径补全 /
 * SCM 只读查询 / 目录与 git-dir watcher）。
 *
 * 全部为无状态 fs 操作 + 两个自持的 watcher（当前列出目录、git dir），
 * 经 FilesHost 回调与 ClientSession 解耦。
 */
import { mkdirSync, statSync, writeFileSync, watch } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { ServerMessage, FileEntry, FileSearchResult } from "./protocol.js";
import type { ServerLang } from "./i18n.js";
import { previewKind, looksLikeText, decodeText, hexDump, countLines } from "./text-sniff.js";
import { gitDirOf, isNotRepoError, scmStatus, scmHistory, scmFileDiff, scmCommitDetail } from "./scm.js";

export const IS_WIN32 = process.platform === "win32";

/** 机器根虚拟路径：工作区「上一级」到达此处，列出所有盘符（Windows）/ "/"（posix）。
 *  这是 wire 字面量，前端 web/src/components/{RightPanel,FooterBar}.tsx 里同值使用。 */
export const MACHINE_ROOT = "@root";

/** wire 路径统一用 "/"。绝对 = posix "/..."；win32 还有 "C:/..." / 裸 "C:"。
 *  机器浏览（越过工作区根换盘符）发送这些路径；工作区相对树不会产生它们（Windows
 *  文件名不能含 ":"，相对路径经 relative() 归一化后也不以 "/" 开头）。 */
export function isAbsoluteWirePath(p: string): boolean {
	if (p === MACHINE_ROOT || p.startsWith("/")) return true;
	return IS_WIN32 && /^[A-Za-z]:([\\/]|$)/.test(p);
}

/** 去掉结尾 "/"（保留 posix 根 "/" 本身），归一成规范的 wire 形式。前端面包屑
 *  不产生结尾斜杠，这里只对补全/直接输入做防御性清理。 */
export function normWirePath(p: string): string {
	if (p.endsWith("/") && p !== "/") return p.slice(0, -1);
	return p;
}

/** wire 绝对路径（"C:/Users/x" / "/Users/x" / "C:"）→ 原生绝对路径。
 *  裸盘符根（"C:"）在 win32 的 resolve 里会落到「C: 上的当前目录」，必须显式转 "C:\\"。 */
export function wireToAbs(wire: string): string {
	const w = normWirePath(wire);
	if (IS_WIN32) {
		const m = /^([A-Za-z]):$/.exec(w);
		if (m) return `${m[1].toUpperCase()}:\\`;
	}
	return resolve(w);
}

/** 机器浏览模式下某目录的父级 wire 路径：盘符根（"C:"）→ 机器根；posix "/" 无父级。 */
export function absoluteParent(wire: string): string | null {
	const s = normWirePath(wire);
	if (s === "" || s === MACHINE_ROOT) return null;
	const i = s.lastIndexOf("/");
	if (i < 0) return IS_WIN32 && /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	if (i === 0) return "/"; // posix "/a" → "/"
	return s.slice(0, i);
}
/** 预览只读文件前 512KB。 */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** 右键上传单文件上限（内存中转 base64 → Buffer）。 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// mac/linux: hide build & dependency noise (original behavior).
const IGNORED_ENTRIES = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
	".pi-web",
	".DS_Store",
	"Thumbs.db",
]);

// Windows: the file tree is the primary way to navigate a project, so only
// hide what would flood or destabilize the panel (dependency trees, VCS
// internals, session data) plus pure junk. Build output (dist/.next/…) and
// local env dirs (venv/__pycache__/…) stay visible — "所有文件可查看".
const IGNORED_ENTRIES_WIN = new Set(["node_modules", ".git", ".pi-web", ".DS_Store", "Thumbs.db", "desktop.ini"]);

/** The ignore set for the current platform — keeps win/posix lists separate. */
function ignoredEntries(): Set<string> {
	return IS_WIN32 ? IGNORED_ENTRIES_WIN : IGNORED_ENTRIES;
}

/**
 * Resolve a workspace-relative path against a root, refusing traversal
 * (".." escapes). Returns { abs, rel } — rel is normalized and slash-
 * separated — or null when the path leaves the workspace.
 */
export function workspacePath(root: string, raw: string): { abs: string; rel: string } | null {
	const abs = resolve(root, raw);
	const rawRel = relative(root, abs);
	if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) return null;
	// Normalize to forward slashes: the wire protocol and the frontend always
	// use "/", but relative() returns "\\" on Windows.
	return { abs, rel: rawRel.split(sep).join("/") };
}

/**
 * Read a directory for the file panel. The two platforms intentionally use
 * different strategies — do NOT unify them:
 *
 * darwin/linux (posix): hide build/dependency noise, small cap; a listing
 * failure (deleted/renamed dir → ENOENT/ENOTDIR, permission → EACCES/EPERM)
 * degrades to an empty listing plus a notice chosen by errorCode — the server
 * must NEVER crash on a vanished directory (issue #74).
 *
 * win32: stability and completeness first, preview second. ACL-protected
 * system dirs (C:\$Recycle.Bin, Program Files internals, OneDrive placeholders)
 * throw EPERM/EACCES on open — that must not kill the panel, so it degrades
 * to an empty listing plus a warning. Directory symlinks/junctions are
 * followed so mklink /D folders stay navigable; broken links still show as
 * files instead of vanishing. The cap is 4x posix and truncation is reported
 * via `truncated` instead of happening silently.
 */
async function readDirForUI(
	abs: string,
	rel: string,
): Promise<{ entries: FileEntry[]; truncated: boolean; error?: string; errorCode?: string }> {
	const { join } = await import("node:path");
	const fs = await import("node:fs/promises");
	const ignored = ignoredEntries();
	const MAX = IS_WIN32 ? 2000 : 500;

	let dirents: import("node:fs").Dirent[];
	try {
		dirents = await fs.readdir(abs, { withFileTypes: true });
	} catch (err) {
		// 任何 readdir 失败都降级为“空列表 + notice”，绝不向上抛：listFiles 以
		// fire-and-forget（void …）调用，未处理的 rejection 会成为 unhandled
		// rejection 直接杀掉整个服务进程（issue #74：目录被删除/改名后刷新即崩）。
		// 缺失（ENOENT/ENOTDIR）、权限拒绝（EACCES/EPERM）、系统 ACL 目录全部归此，
		// 文案由 listFiles 按 errorCode 分类：缺失 = 软提示“目录不存在”，
		// 权限/其余 = posix 硬错误 notice / win32 软提示（ACL 系统目录是常态）。
		const e = err as NodeJS.ErrnoException;
		return { entries: [], truncated: false, error: e.message, errorCode: e.code };
	}

	const out: FileEntry[] = [];
	for (const d of dirents) {
		if (ignored.has(d.name)) continue;
		let type: "dir" | "file";
		if (IS_WIN32 && d.isSymbolicLink()) {
			// mklink /D symlinks and junctions are reparse points — libuv
			// classifies them as links, so isDirectory() is false. Follow the
			// target so folder links stay navigable; broken links still show.
			try {
				const st = await fs.stat(join(abs, d.name));
				type = st.isDirectory() ? "dir" : "file";
			} catch {
				type = "file";
			}
		} else {
			type = d.isDirectory() ? "dir" : "file";
		}
		// 机器浏览（绝对路径）下 rel 是绝对 wire 路径；posix 根 "/" 特殊处理避免 "//name"。
		const entryPath = rel === "" ? d.name : rel.endsWith("/") ? `${rel.slice(0, -1)}/${d.name}` : `${rel}/${d.name}`;
		const entry: FileEntry = {
			name: d.name,
			path: entryPath,
			type,
		};
		if (type === "file") entry.kind = previewKind(d.name);
		out.push(entry);
	}

	out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	const truncated = out.length > MAX;
	if (truncated) out.length = MAX;
	return { entries: out, truncated };
}

/** ClientSession 提供给本服务的宿主能力。 */
export interface FilesHost {
	emit: (msg: ServerMessage) => void;
	isDisposed: () => boolean;
	/** 文件面板 / 预览读写 / 补全的工作区根（服务启动 cwd 或会话 cwd）。 */
	getCwd: () => string;
	/** SCM 查询的工作区（当前活动对话所属项目，可能与 getCwd 不同）。 */
	getActiveCwd: () => string;
	/**
	 * 服务端语言（issue #91）：单字段错误通道（scm_data.error、抛错 message 插值）
	 * 经 pick 按此选中文/英文；推 UI 的 notice 已是 text+textEn 双字段，不用它。
	 * 缺省英文。agent-service 接线 () => this.getLang()。
	 */
	getLang?: () => ServerLang;
}

export class FilesService {
	// ---- 当前列出目录的 watcher ----
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;
	/** Recursive-watch state (win32/darwin): one native recursive watcher on the
	 *  workspace root covers the WHOLE tree; watchPath just tracks which listed
	 *  directory file_changed should refresh. */
	private recursiveWatcher = false;
	private watchRoot: string | null = null;
	/** 已对哪个工作区根提示过「实时监听不可用，已回落轮询」——只提示一次。 */
	private degradedNoticedFor: string | null = null;
	// ---- git dir watcher ----
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly host: FilesHost) {}

	/** 机器根列目录（此电脑/盘符列表）；posix 上就是根 "/"。 */
	private async machineRootEntries(): Promise<FileEntry[]> {
		const fsp = await import("node:fs/promises");
		if (IS_WIN32) {
			const out: FileEntry[] = [];
			for (let c = 65; c <= 90; c++) {
				const drive = `${String.fromCharCode(c)}:`;
				try {
					const st = await fsp.stat(`${drive}\\`);
					if (st.isDirectory()) out.push({ name: drive, path: drive, type: "dir" });
				} catch {
					// 空口/未挂载盘符 —— 跳过
				}
			}
			return out;
		}
		return [{ name: "/", path: "/", type: "dir" }];
	}

	/** 单字段错误文本的语言（host 未接线时英文默认）。 */
	private lang(): ServerLang {
		return this.host.getLang?.() ?? "en";
	}

	/** 目录列表失败的 notice：缺失路径（ENOENT/ENOTDIR）是删除/改名等正常场景，
	 *  软提示“目录不存在”；其余（权限拒绝等）保留原平台语义——win32 软提示
	 *  （ACL 系统目录常见），posix 硬错误（error 级 notice，取代曾经的 throw）。 */
	private emitListError(path: string, error: string, code?: string): void {
		if (code === "ENOENT") {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `Directory not found: ${path}`,
			});
			return;
		}
		if (code === "ENOTDIR") {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `Not a directory: ${path}`,
			});
			return;
		}
		this.host.emit({
			type: "notice",
			level: IS_WIN32 ? "warning" : "error",
			text: `Directory is not readable: ${error}`,
		});
	}

	async listFiles(relPath?: string): Promise<void> {
		const { resolve, sep, relative } = await import("node:path");
		const root = resolve(this.host.getCwd());
		const raw = relPath ?? "";

		// ---- 机器根（此电脑：盘符列表）—— 工作区之上的虚拟层 ----
		if (raw === MACHINE_ROOT || raw === MACHINE_ROOT + "/") {
			const entries = await this.machineRootEntries();
			this.host.emit({
				type: "files",
				path: MACHINE_ROOT,
				parent: null,
				entries,
				truncated: false,
				absolute: true,
			});
			return;
		}

		// ---- 绝对路径浏览（Windows 盘符 / posix "/"）：允许越过工作区根 ----
		// 机器模式不设 watcher（工作区递归 watch 不覆盖别的盘），文件变动靠 10s 轮询。
		if (isAbsoluteWirePath(raw)) {
			const wire = normWirePath(raw);
			const abs = wireToAbs(wire);
			const { entries, truncated, error, errorCode } = await readDirForUI(abs, wire);
			this.host.emit({
				type: "files",
				path: wire,
				parent: absoluteParent(wire),
				entries,
				truncated,
				absolute: true,
			});
			if (error) this.emitListError(wire, error, errorCode);
			return;
		}

		// ---- 工作区相对视图（原有行为） ----
		const target = raw ? resolve(root, raw) : root;
		const rawRel = relative(root, target);
		if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: `Path is outside the workspace: ${relPath ?? ""}`,
			});
			return;
		}
		// Normalize to forward slashes: the wire protocol and the frontend
		// always use "/", but relative() returns "\\" on Windows.
		const rel = rawRel.split(sep).join("/");
		const { entries, truncated, error, errorCode } = await readDirForUI(target, rel);
		// Watch the listed directory only after a successful read — a missing
		// dir must not create a watcher on a phantom path (issue #74).
		if (error) {
			this.emitListError(rel === "" ? root : rel, error, errorCode);
		} else {
			this.watchDir(target, rel);
		}
		this.host.emit({
			type: "files",
			path: rel === "" ? "" : rel,
			// 工作区根也允许「上一级」→ 机器根（Windows 换盘符 / posix 到 /）。
			parent: rel === "" ? MACHINE_ROOT : rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
			entries,
			truncated,
		});
	}

	/**
	 * Global search: recursive filename match across the active workspace.
	 * Best-effort bounded walk — ignored dirs (node_modules/.git/…) are
	 * skipped, unreadable dirs silently passed, and hard caps on results /
	 * visited entries / elapsed time keep big repos responsive. Always answers
	 * with a search_files_result echoing reqId so the client's request never
	 * stalls (ok:false on unexpected failure).
	 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		const { join } = await import("node:path");
		const fsp = await import("node:fs/promises");
		const q = query.trim().toLowerCase();
		if (!q) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const root = resolve(this.host.getActiveCwd());
		const ignored = ignoredEntries();
		const MAX_RESULTS = 50;
		const MAX_VISITED = 20000;
		const MAX_MS = 4000;
		const start = Date.now();
		const results: FileSearchResult[] = [];
		let visited = 0;
		let truncated = false;
		const budgetLeft = () => results.length < MAX_RESULTS && visited < MAX_VISITED && Date.now() - start < MAX_MS;
		// Breadth-first-ish iterative stack; depth cap is a symlink-cycle guard.
		const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
			if (!budgetLeft() || depth > 24) {
				truncated = true;
				return;
			}
			let dirents: import("node:fs").Dirent[];
			try {
				dirents = await fsp.readdir(abs, { withFileTypes: true });
			} catch {
				return; // unreadable dir (ACL/permissions) — skip silently
			}
			for (const d of dirents) {
				visited++;
				if (!budgetLeft()) {
					truncated = true;
					break;
				}
				if (ignored.has(d.name)) continue;
				const childRel = rel ? `${rel}/${d.name}` : d.name;
				if (d.name.toLowerCase().includes(q)) {
					results.push({
						path: childRel,
						name: d.name,
						type: d.isDirectory() ? "dir" : "file",
					});
				}
				if (d.isDirectory()) {
					await walk(join(abs, d.name), childRel, depth + 1);
				}
			}
		};
		try {
			await walk(root, "", 0);
			this.host.emit({
				type: "search_files_result",
				reqId,
				ok: true,
				results,
				...(truncated ? { truncated: true } : {}),
			});
		} catch {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
		}
	}

	/**
	 * Source-control panel: read-only git queries via server-side execFile
	 * (no shell, no prompts). Always responds with an scm_data message echoing
	 * reqId so the client's request matching never stalls. Also (re)arms the
	 * git-dir watcher so external repo changes push scm_changed.
	 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		const cwd = this.host.getActiveCwd();
		if (kind === "status") this.watchGitDir(cwd);
		try {
			if (kind === "status") {
				const data = await scmStatus(cwd, () => this.lang());
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, ...data });
				return;
			}
			if (kind === "history") {
				const history = await scmHistory(cwd, () => this.lang());
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, history });
				return;
			}
			if (kind === "filediff" && arg?.path) {
				// Path stays inside the workspace (defense in depth — paths come
				// from our own listing, and execFile passes args verbatim anyway).
				const { resolve, relative } = await import("node:path");
				const rel = relative(resolve(cwd), resolve(cwd, arg.path));
				if (rel.startsWith("..") || rel === "") throw new Error("Path is outside the workspace");
				const { staged, worktree } = await scmFileDiff(cwd, arg.path, () => this.lang());
				this.host.emit({
					type: "scm_data",
					reqId,
					kind,
					ok: true,
					stagedText: staged,
					worktreeText: worktree,
				});
				return;
			}
			if (kind === "commit" && arg?.hash && /^[0-9a-f]{7,40}$/i.test(arg.hash)) {
				const text = await scmCommitDetail(cwd, arg.hash, () => this.lang());
				this.host.emit({ type: "scm_data", reqId, kind, ok: true, text });
				return;
			}
			throw new Error("Invalid scm query arguments");
		} catch (err) {
			if (isNotRepoError(err)) {
				// Not a repo — a valid empty answer so the panel shows its hint.
				this.host.emit({
					type: "scm_data",
					reqId,
					kind,
					ok: true,
					notRepo: true,
					branch: "",
					detached: false,
					upstream: null,
					ahead: 0,
					behind: 0,
					upstreamGone: false,
					files: [],
					branches: [],
					stats: {},
					history: [],
				});
				this.unwatchGit();
				return;
			}
			this.host.emit({
				type: "scm_data",
				reqId,
				kind,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Watch the active repo's git dir (HEAD / index / packed-refs live at the
	 * top level, which covers commit / stage / checkout). Re-targets when the
	 * queried workspace changes. Uses `git rev-parse --absolute-git-dir` so
	 * worktrees and submodules resolve to the real dir.
	 */
	private async watchGitDir(cwd: string): Promise<void> {
		if (this.gitWatchCwd === cwd && this.gitWatcher) return;
		this.unwatchGit();
		this.gitWatchCwd = cwd;
		try {
			const gitDir = await gitDirOf(cwd);
			if (!gitDir) return;
			this.gitWatcher = watch(gitDir, { persistent: false }, () => {
				if (this.host.isDisposed() || this.gitDirtyTimer) return;
				// Debounce: one checkout/commit fires several fs events.
				this.gitDirtyTimer = setTimeout(() => {
					this.gitDirtyTimer = null;
					this.host.emit({ type: "scm_changed" });
				}, 600);
			});
			this.gitWatcher.on("error", () => {
				// Unsupported filesystem — silently fall back to manual refresh.
				this.unwatchGit();
			});
		} catch {
			// no .git here (or git missing) — watcher stays off; queries still work
			this.unwatchGit();
		}
	}

	unwatchGit(): void {
		if (this.gitWatcher) {
			try {
				this.gitWatcher.close();
			} catch {
				// already gone
			}
		}
		this.gitWatcher = null;
		this.gitWatchCwd = null;
		if (this.gitDirtyTimer) {
			clearTimeout(this.gitDirtyTimer);
			this.gitDirtyTimer = null;
		}
	}

	private watchDir(absPath: string, rel: string): void {
		if (this.host.isDisposed()) return;
		// ---- Recursive mode (native on win32 / darwin): watch the workspace
		// root once, so deep changes in NOT-listed subdirectories still refresh
		// the panel (the old per-directory watch only saw the current level).
		if (process.platform === "win32" || process.platform === "darwin") {
			const root = resolve(this.host.getCwd());
			if (this.recursiveWatcher) {
				if (this.watchRoot === root) {
					// Same workspace — only retarget the refresh path.
					this.watchPath = rel;
					return;
				}
				this.unwatchDir(); // cwd switched to another project
			}
			try {
				const w = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
					// Skip high-churn subtrees (npm install storms); .git has its
					// own watcher for the SCM panel. filename may be null on some
					// platforms — let those through (debounce absorbs bursts).
					if (filename) {
						const f = String(filename).split("\\").join("/");
						// Single-segment names (e.g. the dir itself) have no "/" —
						// slice(0, -1) would corrupt them, so special-case that.
						const slash = f.indexOf("/");
						const top = slash === -1 ? f : f.slice(0, slash);
						if (top === "node_modules" || top === ".git") return;
					}
					// Burst events are debounced into a single refresh.
					if (this.watchTimer) return;
					this.watchTimer = setTimeout(() => {
						this.watchTimer = null;
						this.host.emit({
							type: "file_changed",
							path: this.watchPath ?? "",
						});
					}, 400);
				});
				w.on("error", () => {
					// Directory deleted / unsupported — fall back to poll semantics.
					this.noticeDegraded(root);
					this.unwatchDir();
				});
				this.fsWatcher = w;
				this.watchRoot = root;
				this.recursiveWatcher = true;
				this.watchPath = rel;
				return;
			} catch {
				// recursive unsupported here — fall through to per-directory watch.
				this.fsWatcher = null;
				this.recursiveWatcher = false;
				this.watchRoot = null;
				this.noticeDegraded(root);
			}
		}
		// ---- Fallback: single non-recursive watch on the LISTED directory.
		if (!this.recursiveWatcher && this.watchPath === rel && this.fsWatcher) return;
		this.unwatchDir();
		this.watchPath = rel;
		try {
			// persistent: false — the watcher must not keep the process alive.
			this.fsWatcher = watch(absPath, { persistent: false }, () => {
				// Burst events (npm install, git ops, editor save→rename) are
				// debounced into a single refresh.
				if (this.watchTimer) return;
				this.watchTimer = setTimeout(() => {
					this.watchTimer = null;
					this.host.emit({ type: "file_changed", path: this.watchPath ?? "" });
				}, 400);
			});
			this.fsWatcher.on("error", () => {
				// Directory deleted / unsupported fs — stop watching; the poll (or
				// the next navigation) restores things.
				this.unwatchDir();
			});
		} catch {
			// fs.watch unsupported (some network mounts, containers) — poll covers it.
			this.fsWatcher = null;
			this.watchPath = null;
			this.noticeDegraded(absPath);
		}
	}

	/** 实时监听不可用（网络盘/WSL/受限目录）：一次性告知用户已回落 10s 轮询，
	 *  免得疑惑「面板为什么不实时」。每个工作区根只提示一次。 */
	private noticeDegraded(root: string): void {
		if (this.degradedNoticedFor === root) return;
		this.degradedNoticedFor = root;
		this.host.emit({
			type: "notice",
			level: "info",
			text: "Live file watching is not supported for this directory (network/restricted); the file panel now refreshes every 10s",
		});
	}

	unwatchDir(): void {
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = null;
		}
		if (this.fsWatcher) {
			try {
				this.fsWatcher.close();
			} catch {
				// already closed
			}
			this.fsWatcher = null;
		}
		this.recursiveWatcher = false;
		this.watchRoot = null;
		this.watchPath = null;
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		try {
			const fs = await import("node:fs/promises");
			const root = this.host.getCwd();
			const absWire = isAbsoluteWirePath(relPath);
			let abs: string;
			let rel: string;
			if (absWire) {
				// 机器浏览：绝对路径直接读；回显用绝对 wire 形式（前端按 path 匹配）。
				abs = wireToAbs(relPath);
				rel = abs.split(sep).join("/");
			} else {
				const w = workspacePath(resolve(root), relPath);
				if (!w) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `Path is outside the workspace: ${relPath}`,
					});
					return;
				}
				abs = w.abs;
				rel = w.rel;
			}
			const stat = await fs.stat(abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `Not a file: ${relPath}`,
				});
				return;
			}
			const name = relPath.split(/[\\/]/).pop() ?? relPath;
			const kind = previewKind(name);
			// Media previews stream over the /api/file HTTP endpoint, so only
			// metadata is sent here — the raw bytes never touch the socket.
			if (kind === "image" || kind === "video") {
				this.host.emit({
					type: "file_content",
					path: rel,
					name,
					text: "",
					truncated: false,
					binary: true,
					kind,
					lines: 0,
					size: stat.size,
				});
				return;
			}
			// Everything else: read a capped prefix and sniff the content.
			// Anything that looks like text previews as text regardless of its
			// extension (jsonl, .log.1, weird suffixes, …); binary content gets
			// a hex dump of the first few KB instead of being refused.
			const handle = await fs.open(abs, "r");
			try {
				const buf = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
				const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
				const data = buf.subarray(0, bytesRead);
				if (looksLikeText(data)) {
					this.host.emit({
						type: "file_content",
						path: rel,
						name,
						text: decodeText(data),
						truncated: bytesRead < stat.size,
						binary: false,
						kind: "text",
						lines: countLines(data),
						size: stat.size,
					});
				} else {
					this.host.emit({
						type: "file_content",
						path: rel,
						name,
						text: hexDump(data),
						truncated: bytesRead < stat.size,
						binary: true,
						kind: kind === "text" ? "text" : "none",
						lines: 0,
						size: stat.size,
					});
				}
			} finally {
				await handle.close();
			}
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to read file: ${(err as Error).message}`,
			});
		}
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		try {
			const root = this.host.getCwd();
			const absWire = isAbsoluteWirePath(relPath);
			let abs: string;
			let rel: string;
			if (absWire) {
				abs = wireToAbs(relPath);
				rel = abs.split(sep).join("/");
			} else {
				const w = workspacePath(resolve(root), relPath);
				if (!w) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `Path is outside the workspace: ${relPath}`,
					});
					return;
				}
				abs = w.abs;
				rel = w.rel;
			}
			if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: "File too large to save (2MB max)",
				});
				return;
			}
			const stat = statSync(abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `Not a file: ${relPath}`,
				});
				return;
			}
			writeFileSync(abs, text, "utf8");
			this.host.emit({
				type: "notice",
				level: "info",
				text: `Saved: ${rel}`,
			});
			// Re-read through the same path as the preview request so the client
			// gets the canonical content, line count and file size after saving.
			await this.readFile(rel);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to save file: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * Upload a file (base64, no data: prefix) INTO a workspace directory —
	 * the file manager's right-click “upload here” action. The target dir may
	 * be nested and is created on demand; the name is basename-sanitized so a
	 * malicious payload can't escape the directory. Emits notice + file_changed
	 * for the target dir (the recursive watcher may not cover it on posix).
	 */
	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		const emitErr = (text: string) => this.host.emit({ type: "notice", level: "error", text });
		try {
			const root = this.host.getCwd();
			const absDir = relDir ? isAbsoluteWirePath(relDir) : false;
			let wp: { abs: string; rel: string } | null;
			if (relDir && !absDir) {
				wp = workspacePath(resolve(root), relDir);
				if (!wp) {
					emitErr(`Path outside workspace: ${relDir}`);
					return;
				}
			} else if (relDir) {
				// 机器浏览的目录（可能是盘符根 "C:"）：按绝对路径解析。
				wp = { abs: wireToAbs(relDir), rel: wireToAbs(relDir).split(sep).join("/") };
			} else {
				wp = { abs: root, rel: "" };
			}
			// Basename only — strips any path separators / ".." the name carries;
			// reject empty results and Windows-illegal characters outright.
			const base = name.split(/[\\/]/).pop() ?? "";
			const safe = (base.replace(/[/:*?"<>|\x00-\x1f]/g, "_").trim() || "file").slice(0, 200);
			const abs = resolve(wp.abs, safe);
			let uploadRel: string;
			if (absDir) {
				// 绝对目录模式不再校验工作区归属（机器浏览）。
				uploadRel = abs.split(sep).join("/");
			} else {
				const rawRel = relative(root, abs);
				if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`)) {
					emitErr(`Invalid file name: ${name}`);
					return;
				}
				uploadRel = rawRel.split(sep).join("/");
			}
			const buf = Buffer.from(data, "base64");
			if (buf.length === 0) {
				emitErr(`Empty file: ${name}`);
				return;
			}
			if (buf.length > MAX_UPLOAD_BYTES) {
				emitErr(`File too large: ${name} (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
				return;
			}
			mkdirSync(wp.abs, { recursive: true });
			writeFileSync(abs, buf);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `Uploaded: ${uploadRel}`,
			});
			// Emit for the target directory itself so the panel refreshes even
			// when the active listing/preview isn't that dir (posix watcher only
			// sees the LISTED directory).
			this.host.emit({
				type: "file_changed",
				path: wp.rel,
			});
		} catch (err) {
			emitErr(`Upload failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Create a folder. Accepts absolute, ~-prefixed or session-relative paths
	 * (same expansion rules as completePath — the cwd picker may browse outside
	 * the session root, and set_cwd itself accepts any directory). Answers
	 * with a notice; the picker refreshes its listing on its own.
	 */
	async makeDir(input: string): Promise<void> {
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			let expanded = input.trim();
			if (!expanded) throw new Error("Empty path");
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(this.host.getCwd(), expanded);
			}
			const abs = resolve(expanded);
			await fs.mkdir(abs, { recursive: true });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `Folder created: ${abs}`,
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to create folder: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		const empty = () => this.host.emit({ type: "path_completions", completions: [] });
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			const cwd = this.host.getCwd();
			const isWin = IS_WIN32;
			const rawInput = input.trim();
			if (rawInput === "") {
				empty();
				return;
			}

			// ---- 机器根（此电脑/盘符列表）----
			if (rawInput === MACHINE_ROOT || rawInput === MACHINE_ROOT + "/") {
				this.host.emit({ type: "path_completions", completions: await this.machineRootEntries() });
				return;
			}

			// ---- Windows 盘符输入："D"（补全到盘符，Tab 即换盘）/ "D:"（列盘根）----
			if (isWin && /^[A-Za-z]:?$/.test(rawInput)) {
				const letter = rawInput[0].toUpperCase();
				const drive = `${letter}:`;
				let st: { isDirectory(): boolean };
				try {
					st = await fs.stat(`${drive}\\`);
				} catch {
					empty();
					return;
				}
				if (!st.isDirectory()) {
					empty();
					return;
				}
				if (rawInput.length === 2) {
					// 已带冒号：直接列出盘根条目。
					const dirents = await fs.readdir(`${drive}\\`, { withFileTypes: true }).catch(() => null);
					if (!dirents) {
						empty();
						return;
					}
					const items = dirents
						.filter((d) => !ignoredEntries().has(d.name))
						.map((d) => ({
							name: d.name,
							path: `${drive}/${d.name}`,
							type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
						}))
						.sort((a, b) => {
							const aHidden = a.name.startsWith(".");
							const bHidden = b.name.startsWith(".");
							if (aHidden !== bHidden) return aHidden ? 1 : -1;
							if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
							return a.name.localeCompare(b.name);
						})
						.slice(0, 100);
					this.host.emit({ type: "path_completions", completions: items });
					return;
				}
				// 只有字母：补全到盘符本身。
				this.host.emit({ type: "path_completions", completions: [{ name: drive, path: drive, type: "dir" }] });
				return;
			}

			// Expand ~ and relative inputs to an absolute path. Windows users type
			// backslashes (P:\agent) and ~\ — handle both separator styles.
			let expanded = rawInput;
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(cwd, expanded);
			}

			// Split into parent dir + prefix on the LAST separator of either style
			// (Windows accepts both / and \, so P:\agent/de must work too).
			const lastSlash = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
			const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "";
			const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

			const dirents = await fs.readdir(dirPart, { withFileTypes: true }).catch(() => null);
			if (!dirents) {
				empty();
				return;
			}
			const { join } = await import("node:path");
			const completions = dirents
				.filter((d) => d.name.startsWith(prefix) && !ignoredEntries().has(d.name))
				.map((d) => ({
					name: d.name,
					// Windows users type backslashes — normalize the completion to the
					// wire format ("/") so the picked path round-trips cleanly.
					path: IS_WIN32 ? join(dirPart, d.name).split(sep).join("/") : dirPart + d.name,
					type: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
				}))
				.sort((a, b) => {
					const aHidden = a.name.startsWith(".");
					const bHidden = b.name.startsWith(".");
					if (aHidden !== bHidden) return aHidden ? 1 : -1;
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 100);
			this.host.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}
}
