import { memo, useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
	FiCheck,
	FiChevronDown,
	FiChevronRight,
	FiChevronsLeft,
	FiEdit2,
	FiFolder,
	FiGitBranch,
	FiPlus,
	FiSearch,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { ConversationSummary, ProjectSummary, SessionSummary, WorktreeSummary } from "../types";
import type { WorktreeResult } from "../use-chat";
import { useT } from "../i18n";
import { Logo } from "./Logo";
import { useAppField } from "../app-globals";
import {
	buildLeftNav,
	cwdKey,
	pendingSessionCwds,
	stableProjectOrder,
	worktreeLabel,
	type NavGroup,
} from "./left-panel-nav";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	readonly onOpenGlobalSearch: () => void;
	sessionFile: string | null;
	conversations: ConversationSummary[];
	/** Persisted sessions per project cwd (server echoes the queried cwd). */
	sessionsByCwd: Map<string, SessionSummary[]>;
	projects: ProjectSummary[];
	activeConversationId: string;
	/** Latest worktree_add/remove outcome — a dirty-removal refusal asks
	 *  for confirmation here and retries with force. */
	worktreeResult: (WorktreeResult & { seq: number }) | null;
	panelSend: (
		msg:
			| { type: "new_chat"; cwd?: string | null }
			| { type: "list_sessions"; cwd?: string }
			| { type: "list_projects" }
			| { type: "pick_project_folder" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string }
			| { type: "remove_project"; path: string }
			| { type: "worktree_add"; cwd?: string; branch?: string }
			| { type: "worktree_remove"; path: string; force?: boolean }
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "rename_conversation"; id: string; name: string }
			| { type: "dismiss_conversation"; id: string; force?: boolean },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;
}

function formatModified(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

const LS_COLLAPSED_GROUPS = "pi-web-ui:lp-collapsed-groups";

function loadCollapsedGroups(): Set<string> {
	try {
		const raw = localStorage.getItem(LS_COLLAPSED_GROUPS);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return new Set(parsed.filter((x): x is string => typeof x === "string"));
			}
		}
	} catch {
		// localStorage 不可用（隐私模式/SSR）→ 默认全部展开
	}
	return new Set();
}

export const LeftPanel = memo(function LeftPanel({
	onOpenGlobalSearch,
	sessionFile,
	conversations,
	sessionsByCwd,
	projects,
	activeConversationId,
	worktreeResult,
	panelSend,
	active,
	collapsible,
	onToggleCollapse,
}: LeftPanelProps) {
	const t = useT();
	const currentFile = sessionFile;
	// 连接态与当前工作目录走全局（web/src/app-globals.ts），不再从 App 传
	// —— 这两个值整棵树都要，传参只会越传越漏。
	const ready = useAppField("ready");
	const status = useAppField("status");
	const cwd = useAppField("cwd");
	const currentCwd = cwd;
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	/** 每个项目目录的折叠态（Codex 式嵌套树：目录行可单独折叠）。 */
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);
	/** 展开态切换只改折叠集合；发请求交给下面的可见分组 effect 统一处理。 */
	const toggleGroup = useCallback((path: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			try {
				localStorage.setItem(LS_COLLAPSED_GROUPS, JSON.stringify([...next]));
			} catch {}
			return next;
		});
	}, []);
	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		panelSend({ type: "list_sessions" });
		panelSend({ type: "list_projects" });
	}, [active, ready, status, cwd, panelSend]);

	/** 已成功拉到过会话列表的项目 cwd 以 sessionsByCwd 为准（服务器只在收到
	 *  list_sessions 后回推带 cwd 的 sessions）。in-flight 只是防抖标记，回执到达
	 *  即删；这里不把「已发送」当成「已成功」，否则一次发送失败或重连丢包会把
	 *  项目永久锁死为空。 */
	const inFlightCwds = useRef<Set<string>>(new Set());
	/** WebSocket 打开代数：重连时 +1，用来强制重拉已缓存展开分组的会话列表
	 *  （断线期间的磁盘变动不会被旧缓存反映出来）。 */
	const [liveToken, setLiveToken] = useState(0);
	const wasLive = useRef(false);
	const lastRefreshToken = useRef(0);

	// 连接从「未就绪」变为 open：清掉在途标记（旧 socket 的请求永远不会回执），
	// 并递增代数触发一次强制刷新。
	useEffect(() => {
		const live = ready && status === "open";
		if (live && !wasLive.current) {
			inFlightCwds.current.clear();
			setLiveToken((n) => n + 1);
		}
		wasLive.current = live;
	}, [ready, status]);

	const projectOrder = useRef<string[]>([]);
	const navGroups = useMemo(
		() => stableProjectOrder(buildLeftNav(projects, conversations, sessionsByCwd, currentCwd), projectOrder.current),
		[projects, conversations, sessionsByCwd, currentCwd],
	);
	/** Row the user just clicked, highlighted before the server finishes the
	 *  switch (opening a chat in another project boots a fresh runtime, which
	 *  takes a couple of seconds - the click must not look ignored). Cleared
	 *  when the switch lands or fails. */
	const [pendingTarget, setPendingTarget] = useState<string | null>(null);
	useEffect(() => {
		if (pendingTarget === null) return;
		if (pendingTarget === currentFile || pendingTarget === activeConversationId) setPendingTarget(null);
	}, [pendingTarget, currentFile, activeConversationId]);
	useEffect(() => {
		if (pendingTarget === null) return;
		const id = window.setTimeout(() => setPendingTarget(null), 15000);
		return () => window.clearTimeout(id);
	}, [pendingTarget]);

	// A worktree removal refused for uncommitted changes: confirm, then force.
	const seenWorktreeSeq = useRef(0);
	useEffect(() => {
		if (!worktreeResult || worktreeResult.seq === seenWorktreeSeq.current) return;
		seenWorktreeSeq.current = worktreeResult.seq;
		if (worktreeResult.op !== "remove" || worktreeResult.ok || !worktreeResult.dirty) return;
		const label = worktreeResult.branch ?? worktreeResult.path;
		if (window.confirm(t("removeWorktreeDirtyConfirm", { branch: label }))) {
			panelSend({ type: "worktree_remove", path: worktreeResult.path, force: true });
		}
	}, [worktreeResult, panelSend, t]);

	// 可见且展开的项目都在这里惰性拉取历史：新发现的非当前项目、默认展开但从未
	// 加载的分组都会补上；折叠分组不动。已加载成功的分组仅在重连刷新时重拉一次。
	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		const loaded = new Set(sessionsByCwd.keys());
		// 回执到达 → 清在途标记，避免「发送成功但未回执」与「真正已加载」混淆。
		for (const path of [...inFlightCwds.current]) {
			if (loaded.has(path)) inFlightCwds.current.delete(path);
		}
		const refresh = liveToken !== lastRefreshToken.current;
		lastRefreshToken.current = liveToken;
		const pending = pendingSessionCwds(navGroups, collapsedGroups, loaded, inFlightCwds.current, refresh);
		for (const path of pending) {
			inFlightCwds.current.add(path);
			// 发送失败（socket 未开）不驻留标记，下次连接/依赖变化时可重试。
			if (!panelSend({ type: "list_sessions", cwd: path })) inFlightCwds.current.delete(path);
		}
	}, [active, ready, status, sessionsByCwd, navGroups, collapsedGroups, liveToken, panelSend]);

	const displayName = (s: SessionSummary): string => {
		const title = s.name || s.firstMessage.trim();
		return title.length > 0 ? title : t("emptyChat");
	};

	const delButton = (
		key: string,
		hint: string,
		confirmHint: string,
		onConfirm: () => void,
		icon?: React.ReactNode,
		extraClass = "",
	) => {
		const armed = confirmDel === key;
		return (
			<button
				type="button"
				className={`lp-del ${armed ? "confirm" : ""}${extraClass ? ` ${extraClass}` : ""}`}
				title={armed ? confirmHint : hint}
				onClick={(e) => {
					e.stopPropagation();
					if (armed) {
						setConfirmDel(null);
						onConfirm();
					} else {
						setConfirmDel(key);
					}
				}}
			>
				{armed ? <FiCheck /> : (icon ?? <FiTrash2 />)}
			</button>
		);
	};

	/** Worktree marker for a chat that runs in a linked checkout of its
	 *  project (Claude-desktop style: rows stay flat, the glyph tells them
	 *  apart). Sits before the title; the branch name lives in the tooltip. */
	const branchBadge = (worktree: WorktreeSummary | undefined) => {
		if (!worktree) return null;
		const branch = worktreeLabel(worktree);
		return (
			<span className="lp-branch" title={t("worktreeBranch", { branch })} aria-label={branch}>
				<FiGitBranch aria-hidden="true" />
			</span>
		);
	};

	/** Hover action on a worktree-backed row: remove the checkout (branch
	 *  kept). Two-step like the other destructive buttons; a dirty checkout
	 *  comes back as worktree_result{dirty} and is confirmed above. */
	const removeWorktreeButton = (rowKey: string, worktree: WorktreeSummary | undefined) =>
		worktree
			? delButton(
					`wt:${rowKey}`,
					t("removeWorktree", { branch: worktreeLabel(worktree) }),
					t("removeWorktreeConfirm"),
					() => panelSend({ type: "worktree_remove", path: worktree.path }),
					<FiGitBranch />,
					"lp-row-worktree",
				)
			: null;

	const renderConversationRow = (c: ConversationSummary, depth: number, worktree?: WorktreeSummary) => {
		const active = activeConversationId === c.id;
		const pending = pendingTarget === c.id && !active;
		const key = `conv:${c.id}`;
		return (
			<div
				className={`lp-row${depth > 0 ? " lp-sub" : ""}`}
				key={c.id}
				style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
				onMouseLeave={() => setConfirmDel((k) => (k === key ? null : k))}
			>
				<button
					type="button"
					className={`session-item ${active ? "active" : ""}${pending ? " pending" : ""}`}
					title={c.title}
					onClick={() => {
						if (active) return;
						setPendingTarget(c.id);
						panelSend({ type: "switch_conversation", id: c.id });
					}}
				>
					<span className="session-info">
						{renaming === key ? null : branchBadge(worktree)}
						{renaming === key ? (
							<input
								autoFocus
								className="session-rename-input"
								value={renameDraft}
								placeholder={t("renameSessionPlaceholder")}
								onClick={(e) => e.stopPropagation()}
								onChange={(e) => setRenameDraft(e.target.value)}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										const name = renameDraft.trim();
										if (name) panelSend({ type: "rename_conversation", id: c.id, name });
										setRenaming(null);
									} else if (e.key === "Escape") {
										setRenaming(null);
									}
								}}
								onBlur={() => setRenaming(null)}
							/>
						) : (
							<span className="session-title">{c.title}</span>
						)}
						{renaming === key ? null : (
							<span className="session-sub">{active ? t("current") : t("messageCount", { n: c.messageCount })}</span>
						)}
					</span>
					{(c.isStreaming || pending) && <span className="conv-streaming" title={t("streaming")} />}
				</button>
				<button
					type="button"
					className="lp-del lp-rename"
					title={t("renameSession")}
					onClick={(e) => {
						e.stopPropagation();
						setConfirmDel(null);
						setRenameDraft(c.title);
						setRenaming(key);
					}}
				>
					<FiEdit2 />
				</button>
				{removeWorktreeButton(key, worktree)}
				{(() => {
					// Idle: two-step confirm then dismiss (the active one too — the
					// server switches away first). Streaming: two-step force-dismiss
					// (aborts the run).
					if (!c.isStreaming) {
						return delButton(
							key,
							t("dismissConversation"),
							t("dismissConversationConfirm"),
							() => panelSend({ type: "dismiss_conversation", id: c.id }),
							<FiX />,
						);
					}
					return delButton(
						key,
						t("dismissConversation"),
						t("dismissStreamingConfirm"),
						() => panelSend({ type: "dismiss_conversation", id: c.id, force: true }),
						<FiX />,
					);
				})()}
			</div>
		);
	};

	const renderSessionRow = (s: SessionSummary, worktree?: WorktreeSummary) => {
		const active = currentFile === s.path;
		const pending = pendingTarget === s.path && !active;
		const key = `sess:${s.path}`;
		return (
			<div className="lp-row" key={s.path} onMouseLeave={() => setConfirmDel((k) => (k === key ? null : k))}>
				<button
					type="button"
					className={`session-item ${active ? "active" : ""}${pending ? " pending" : ""}`}
					title={s.path}
					onClick={() => {
						if (renaming || active) return;
						setPendingTarget(s.path);
						panelSend({ type: "switch_session", path: s.path });
					}}
				>
					<span className="session-info">
						{renaming === s.path ? null : branchBadge(worktree)}
						{renaming === s.path ? (
							<input
								autoFocus
								className="session-rename-input"
								value={renameDraft}
								placeholder={t("renameSessionPlaceholder")}
								onClick={(e) => e.stopPropagation()}
								onChange={(e) => setRenameDraft(e.target.value)}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										const name = renameDraft.trim();
										if (name) panelSend({ type: "rename_session", path: s.path, name });
										setRenaming(null);
									} else if (e.key === "Escape") {
										setRenaming(null);
									}
								}}
								onBlur={() => setRenaming(null)}
							/>
						) : (
							<span className="session-title">{displayName(s)}</span>
						)}
						{renaming === s.path ? null : (
							<span className="session-sub">
								{active ? t("current") : t("messageCount", { n: s.messageCount })}
								{s.source === "tui" && (
									<span className="session-src" title={t("tuiTip")}>
										TUI
									</span>
								)}
							</span>
						)}
					</span>
					<span className="session-time">{formatModified(s.modified)}</span>
					{pending && <span className="conv-streaming" aria-hidden="true" />}
				</button>
				<button
					type="button"
					className="lp-del lp-rename"
					title={t("renameSession")}
					onClick={(e) => {
						e.stopPropagation();
						setConfirmDel(null);
						setRenameDraft(s.name ?? "");
						setRenaming(s.path);
					}}
				>
					<FiEdit2 />
				</button>
				{removeWorktreeButton(key, worktree)}
				{delButton(key, t("deleteSession"), t("deleteSessionConfirm"), () =>
					panelSend({ type: "delete_session", path: s.path }),
				)}
			</div>
		);
	};

	const groups = navGroups.filter((g) => g.isProject);
	const recents = navGroups.filter((g) => !g.isProject);

	return (
		<aside className="panel panel-left lp-panel">
			{/* Astra 品牌 + 突出的「新对话」——替代旧顶栏的 new_chat 入口。 */}
			<div className="lp-brand">
				<span className="lp-brand-title">
					<Logo size={20} />
					<span className="lp-brand-name">Dispatch</span>
				</span>
				<span className="lp-brand-actions">
					<button
						type="button"
						className="lp-icon-btn lp-search"
						title={t("searchGlobal")}
						aria-label={t("searchGlobal")}
						onClick={onOpenGlobalSearch}
					>
						<FiSearch />
					</button>
					{collapsible && onToggleCollapse && (
						<button
							type="button"
							className="panel-collapse-btn lp-brand-collapse lp-icon-btn"
							title={t("collapsePanel")}
							onClick={onToggleCollapse}
						>
							<FiChevronsLeft />
						</button>
					)}
				</span>
			</div>
			<button
				type="button"
				className="lp-new-chat"
				title={t("newChatTip")}
				onClick={() => panelSend({ type: "new_chat", cwd: null })}
			>
				<FiEdit2 />
				<span>{t("newChat")}</span>
			</button>
			<div className="lp-section-label">
				<span>{t("recentProjects")}</span>
				<button
					type="button"
					className="lp-icon-btn lp-add-project"
					title={t("addProject")}
					aria-label={t("addProject")}
					disabled={!ready}
					onClick={() => panelSend({ type: "pick_project_folder" })}
				>
					<FiPlus />
				</button>
			</div>
			{/* Codex 式统一导航树：项目目录为顶层分组，运行中的对话与当前项目的历史
			    会话按 cwd 嵌套在各目录下（未登记项目的运行对话单独成组，不丢弃）。 */}
			<nav className="lp-nav">
				{groups.length === 0 ? (
					<div className="panel-empty">{t("noHistory")}</div>
				) : (
					groups.map((g: NavGroup) => {
						const collapsed = collapsedGroups.has(g.path);
						const count = g.conversations.length + g.sessions.length;
						return (
							<section
								key={g.path}
								className={`lp-group${g.isCurrent ? " current" : ""}${collapsed ? " collapsed" : ""}`}
							>
								<div
									className="lp-group-head"
									onMouseLeave={() => setConfirmDel((k) => (k === `proj:${g.path}` ? null : k))}
								>
									<button
										type="button"
										className="lp-group-toggle"
										title={collapsed ? t("expandSection") : t("collapseSection")}
										aria-expanded={!collapsed}
										aria-label={g.label}
										onClick={() => toggleGroup(g.path)}
									>
										{collapsed ? <FiChevronRight /> : <FiChevronDown />}
									</button>
									<button
										type="button"
										className={`lp-group-main${g.isCurrent ? " active" : ""}`}
										title={g.path}
										onClick={() => {
											if (!g.isCurrent) panelSend({ type: "set_cwd", path: g.path });
										}}
									>
										<FiFolder className="lp-group-icon" />
										<span className="lp-group-label">{g.label}</span>
										{count > 0 && <span className="lp-group-count">{count}</span>}
									</button>
									{g.worktrees.length > 0 && (
										<button
											type="button"
											className="lp-del lp-project-new lp-project-worktree"
											title={t("newWorktreeChat")}
											aria-label={`${t("newWorktreeChat")} — ${g.label}`}
											onClick={() => {
												setCollapsedGroups((prev) => {
													const next = new Set(prev);
													next.delete(g.path);
													return next;
												});
												panelSend({ type: "worktree_add", cwd: g.path });
											}}
										>
											<FiGitBranch />
										</button>
									)}
									<button
										type="button"
										className="lp-del lp-project-new"
										title={t("newChat")}
										aria-label={`${t("newChat")} — ${g.label}`}
										onClick={() => {
											setCollapsedGroups((prev) => {
												const next = new Set(prev);
												next.delete(g.path);
												return next;
											});
											panelSend({ type: "new_chat", cwd: g.path });
										}}
									>
										<FiEdit2 />
									</button>
									{g.isProject &&
										delButton(`proj:${g.path}`, t("deleteProject"), t("deleteProjectConfirm"), () =>
											panelSend({ type: "remove_project", path: g.path }),
										)}
								</div>
								{!collapsed && (g.conversations.length > 0 || g.sessions.length > 0) && (
									<div className="lp-group-body">
										{g.conversations.length > 0 && (
											<div className="lp-group-convs">
												{g.conversations.map(({ c, depth, worktree }) => renderConversationRow(c, depth, worktree))}
											</div>
										)}
										{g.sessions.map((s) => renderSessionRow(s, g.sessionWorktrees.get(cwdKey(s.path))))}
									</div>
								)}
								{!collapsed && g.isCurrent && g.conversations.length === 0 && g.sessions.length === 0 && (
									<div className="panel-empty">{t("noHistory")}</div>
								)}
							</section>
						);
					})
				)}
				<div className="lp-section-label">{t("recents")}</div>
				<div className="lp-recents">
					{recents.flatMap((g) => g.conversations).map(({ c, depth }) => renderConversationRow(c, depth))}
					{recents
						.flatMap((g) => g.sessions)
						.sort((a, b) => b.modified - a.modified)
						.map((s) => renderSessionRow(s))}
				</div>
			</nav>
			<footer className="lp-footer">
				<span className="lp-footer-avatar" aria-hidden="true">
					<Logo size={12} />
				</span>
				<span className="lp-footer-project" title={cwd}>
					{cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop()}
				</span>
				<span
					className="lp-footer-status"
					title={ready ? t("connected") : status === "closed" ? t("reconnecting") : t("connecting")}
				>
					<span className={`conn-dot ${ready ? "ok" : "busy"}`} />
					<span className="lp-footer-conn">
						{ready ? t("connected") : status === "closed" ? t("reconnecting") : t("connecting")}
					</span>
				</span>
			</footer>
		</aside>
	);
});
