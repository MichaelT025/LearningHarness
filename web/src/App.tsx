import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import {
	FiFolder,
	FiGitBranch,
	FiMenu,
	FiSearch,
	FiServer,
	FiSettings,
	FiTerminal,
	FiSidebar,
	FiUsers,
} from "react-icons/fi";
import { Dialog } from "./components/Dialog";
import { QuestionDialog } from "./components/QuestionDialog";
import { TodoPanel, TodoStrip } from "./components/TodoList";
// 终端视图懒加载：xterm.js 体积大且只在切到终端时才需要，拆出主包
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
import { ScmPanel } from "./components/SCMPanel";
import { WorkersPanel } from "./components/WorkersPanel";
import { BackgroundPanel } from "./components/BackgroundPanel";
import { SubscriptionUsage } from "./components/SubscriptionUsage";
import { OPEN_WORKER_EVENT } from "./components/ToolCallBlock";
import { registerAttachmentSink } from "./composer-bridge";
import { appendDraftAttachments } from "./composer-draft";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal } from "./components/SettingsModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { getClientId, useChat } from "./use-chat";
import { recentConversationIds } from "./conversation-view";
import { parseAgentRole, hasDispatchExtension } from "./agents";
import type { ClientMessage, PromptAttachment, ToolStatus, UiMessage, UiWorker } from "./types";
import { useT } from "./i18n";
import {
	FiAlertCircle,
	FiAlertTriangle,
	FiArrowLeft,
	FiChevronsLeft,
	FiChevronsRight,
	FiInfo,
	FiX,
} from "react-icons/fi";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import { recordModelUsage } from "./model-usage";
import {
	NOTIFICATION_CLICK_EVENT,
	notificationConversationIdFromUrl,
	parseNotificationClickMessage,
	resolveNotificationConversation,
	withoutNotificationConversationId,
} from "./notification-events";
import { useWideChat } from "./chat-width-settings";
import { projectNameFromCwd, useProjectTitle } from "./title-settings";
import { workspaceMaxPx } from "./panel-sash";

export interface PendingAttachment {
	path: string;
	name: string;
	mode: "inline" | "reference" | "lines";
	/** Folder path link (always reference mode). */
	isDir?: boolean;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/** Raw pasted/dropped/uploaded image (no workspace path — `path` is ""). */
	imageData?: string;
	mimeType?: string;
	/** Raw uploaded file bytes (no workspace path — `path` is ""). */
	fileData?: string;
	size?: number;
	/** Stable dedupe/removal key for pasted images. */
	key?: string;
}

/** A single notice toast. Auto-dismisses after a level-dependent delay, but
 *  hovering PAUSES the timer (stays visible as long as the pointer is over it),
 *  resuming when the pointer leaves. Clicking the toast body does NOT hide it —
 *  only the × button dismisses (and the auto timer). */
function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: (id: number) => void }) {
	const t = useT();
	const text = notice.text;
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused) return;
		const t = setTimeout(() => onDismiss(notice.id), notice.level === "error" ? 12000 : 7000);
		return () => clearTimeout(t);
	}, [paused, notice.id, notice.level, onDismiss]);
	const Icon = notice.level === "error" ? FiAlertCircle : notice.level === "warning" ? FiAlertTriangle : FiInfo;
	return (
		<div
			className={`notice notice-${notice.level}${paused ? " paused" : ""}`}
			role="status"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<Icon className="notice-icon" />
			<span className="notice-text">{text}</span>
			<button type="button" className="notice-close" title={t("close")} onClick={() => onDismiss(notice.id)}>
				<FiX />
			</button>
		</div>
	);
}
/** Stable empty messages array — keeps the memoized ChatInput prop comparison
 *  cheap before the first snapshot arrives. */
const EMPTY_MESSAGES: UiMessage[] = [];
/** Stable empties for the parked message lists (no live tool output there). */
const EMPTY_LIVE = new Map<string, { toolName: string; text: string }>();
const EMPTY_STATUSES = new Map<string, ToolStatus>();
/** Conversations whose MessageList stays mounted (the visible one included):
 *  switching back to a recent chat paints its list as it was, scroll
 *  position and expanded rows intact, instead of rebuilding it. */
const KEEP_MOUNTED = 3;

// ---- 可拖拽面板宽度（桌面端；≤768px 抽屉模式固定宽度不受影响）----
const PANEL_MIN = 180;
const PANEL_MAX = 520;
const PANEL_DEFAULT = 240;
/** Astra 右侧工作台：首次打开默认占主区约一半（参考 Codex 右栏比例），可拖更宽。 */
const RIGHT_MIN = 280;
const RIGHT_MAX = 1100;
function defaultWorkspaceWidth(): number {
	const half = Math.round(window.innerWidth * 0.42);
	return Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, half));
}
function readWorkspaceWidth(): number {
	try {
		const v = Number(localStorage.getItem(panelWidthKey("right")));
		if (Number.isFinite(v) && v >= RIGHT_MIN && v <= RIGHT_MAX) return v;
	} catch {}
	return defaultWorkspaceWidth();
}
type PanelSide = "left" | "right";
const panelWidthKey = (side: PanelSide) => `pi-web-ui:${side}-panel-width`;
function readPanelWidth(side: PanelSide): number {
	const v = Number(localStorage.getItem(panelWidthKey(side)));
	return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT;
}
const panelCollapsedKey = (side: PanelSide) => `pi-web-ui:${side}-panel-collapsed`;
function readPanelCollapsed(side: PanelSide): boolean {
	return localStorage.getItem(panelCollapsedKey(side)) === "1";
}

/** 面板与主区之间的拖拽分隔条：拖动改宽度，双击复位。 */
function ResizeHandle({
	side,
	width,
	min = PANEL_MIN,
	max = PANEL_MAX,
	reset,
	onResize,
}: {
	side: PanelSide;
	width: number;
	min?: number;
	max?: number;
	/** Width restored on double-click (defaults to the sidebar default). */
	reset?: () => number;
	onResize: (w: number) => void;
}) {
	const t = useT();
	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = width;
			let last = startW;
			const move = (ev: PointerEvent) => {
				// 左侧手柄向右拖变宽，右侧相反
				const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
				last = Math.min(max, Math.max(min, Math.round(startW + delta)));
				onResize(last);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				document.body.classList.remove("panel-resizing");
				localStorage.setItem(panelWidthKey(side), String(last));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			document.body.classList.add("panel-resizing");
		},
		[side, width, min, max, onResize],
	);
	return (
		<div
			className={`resize-handle resize-${side}`}
			title={t("dragToResize")}
			onPointerDown={onPointerDown}
			onDoubleClick={() => {
				const w = reset ? reset() : PANEL_DEFAULT;
				onResize(w);
				localStorage.setItem(panelWidthKey(side), String(w));
			}}
		/>
	);
}

/** 面板折叠后留在原位置的展开条：贴在主区边缘，点击恢复面板。
 *  只在桌面端出现（移动端抽屉由顶栏按钮控制）。 */
function PanelRail({ side, onClick }: { side: PanelSide; onClick: () => void }) {
	const t = useT();
	return (
		<button type="button" className={`panel-rail panel-rail-${side}`} title={t("expandPanel")} onClick={onClick}>
			{side === "left" ? <FiChevronsRight /> : <FiChevronsLeft />}
		</button>
	);
}

/** Stable empty roster (a fresh [] per render would defeat WorkersPanel's memo). */
const EMPTY_WORKERS: UiWorker[] = [];

/** Right workspace pane: files / git review / delegated workers. The terminal is the bottom strip. */
type WorkspaceTab = "files" | "git" | "workers" | "background";

/** Compact conversation header: project name plus the workspace toggles. */
function AstraHeader({
	chat,
	title,
	onOpenPanel,
	onOpenSettings,
	onOpenGlobalSearch,
	workspaceOpen,
	onToggleWorkspace,
	bottomTerminalOpen,
	onToggleBottomTerminal,
}: {
	chat: { ready: boolean; status: string; state: { cwd: string } | null };
	readonly title: string | undefined;
	onOpenPanel: (side: "left" | "right") => void;
	onOpenSettings: () => void;
	onOpenGlobalSearch: () => void;
	workspaceOpen: boolean;
	onToggleWorkspace: () => void;
	bottomTerminalOpen: boolean;
	onToggleBottomTerminal: () => void;
}) {
	const t = useT();
	const projectName = projectNameFromCwd(chat.state?.cwd ?? "");
	return (
		<header className="astra-header">
			<div className="astra-header-left">
				<button type="button" className="panel-toggle" title={t("openHistory")} onClick={() => onOpenPanel("left")}>
					<FiMenu />
				</button>
				<FiFolder className="astra-header-icon" aria-hidden="true" />
				<span className="astra-project" title={title || projectName}>
					{title || projectName}
				</span>
			</div>
			<div className="astra-header-right">
				<button type="button" className="chip" title={t("searchGlobalTip")} onClick={onOpenGlobalSearch}>
					<FiSearch />
				</button>
				<button type="button" className="chip" title={t("settingsTitle")} onClick={onOpenSettings}>
					<FiSettings />
				</button>
				<button
					type="button"
					className={`chip astra-terminal-toggle${bottomTerminalOpen ? " active" : ""}`}
					title={t("terminal")}
					aria-pressed={bottomTerminalOpen}
					aria-expanded={bottomTerminalOpen}
					onClick={onToggleBottomTerminal}
				>
					<FiTerminal />
				</button>
				<button
					type="button"
					className={`chip astra-workspace-toggle${workspaceOpen ? " active" : ""}`}
					title={t("astraWorkspace")}
					aria-pressed={workspaceOpen}
					onClick={onToggleWorkspace}
				>
					<FiSidebar />
				</button>
			</div>
		</header>
	);
}

export function App() {
	const t = useT();
	const { chat, viewState, blocked, send, dismissNotice, pushNotice, terminal } = useChat();
	// 浏览器标题：开关开启时显示当前项目（工作目录文件夹名），否则固定应用名。
	// `viewState` is what the chat column shows (an optimistic empty chat
	// while a new one boots, else the snapshot) — everything conversation-
	// facing below reads it, not chat.state.
	const cwd = viewState?.cwd ?? "";
	const projectTitle = useProjectTitle();
	useEffect(() => {
		const name = projectTitle ? projectNameFromCwd(cwd) : "";
		document.title = name ? `${name} — Dispatch Web` : t("docTitle");
	}, [cwd, projectTitle, t]);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	// 宿主注入的待发附件（浏览器元素拾取扩展的截图 → window.__piWebUiHost.compose）：
	// 只追加不覆盖，判重口径与下面的 attach() 一致（见 composer-draft.ts）。
	useEffect(() => {
		registerAttachmentSink((items) => setAttachments((prev) => appendDraftAttachments(prev, items)));
		return () => registerAttachmentSink(null);
	}, []);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	/** Inline preview inside the right workspace (no modal). */
	const [workspaceFile, setWorkspaceFile] = useState<PreviewFile | null>(null);
	/** Right workspace pane (Astra shell): open/closed + which panel tab. */
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab | null>(null);
	const [todoFocusRequest, setTodoFocusRequest] = useState(0);
	/** Worker shown in the Workers pane (null = the Active / Done lists). Owned
	 *  here so a delegate card in the chat can open one directly. */
	const [selectedWorker, setSelectedWorker] = useState<number | null>(null);
	/** Independent bottom terminal strip under the chat/right area. */
	const [bottomTerminalOpen, setBottomTerminalOpen] = useState(false);
	/** Full-window file drag in progress (issue #19) — shows the app-wide
	 *  drop overlay; drop anywhere attaches, the input bar keeps priority via
	 *  its own stopPropagation handlers. */
	const [appDragOver, setAppDragOver] = useState(false);
	/* PI_WEB_TABS: a tab this instance does not offer cannot be shown, even if
	   something else asks for it — a plugin firing pi-web-ui:plugin-run-command,
	   or a panel's "open this in a terminal" button. The server refuses those
	   messages anyway, so the pane would sit there empty. No list means every
	   tab, which is the default. */
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);
	// 左右面板可拖拽宽度（桌面端）：localStorage 持久化，双击手柄复位。
	const [leftWidth, setLeftWidth] = useState(() => readPanelWidth("left"));
	const [rightWidth, setRightWidth] = useState(readWorkspaceWidth);
	const resizeLeft = useCallback((w: number) => setLeftWidth(w), []);
	const resizeRight = useCallback((w: number) => setRightWidth(w), []);
	// The workspace pane may never squeeze the chat column under MAIN_MIN_PX:
	// its ceiling follows the window and the sidebar, and the stored width is
	// re-clamped whenever either changes (see panel-sash.ts).
	const [viewportW, setViewportW] = useState(() => window.innerWidth);
	useEffect(() => {
		const onResize = () => setViewportW(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	// 左右面板折叠状态（桌面端）：localStorage 持久化，点击面板内收起按钮折叠，
	// 靠边缘的展开条恢复；移动端抽屉不受影响（始终由顶栏按钮开关）。
	const [leftCollapsed, setLeftCollapsed] = useState(() => readPanelCollapsed("left"));
	const toggleLeft = useCallback(() => {
		setLeftCollapsed((v) => {
			localStorage.setItem(panelCollapsedKey("left"), v ? "0" : "1");
			return !v;
		});
	}, []);
	// Astra 右侧工作台开关（含顶部右上角按钮）。
	const toggleWorkspace = useCallback(() => setWorkspaceOpen((v) => !v), []);
	// Mobile: which side panel is open as a drawer (null = closed).
	const [drawer, setDrawer] = useState<"left" | null>(null);
	const [everBottom, setEverBottom] = useState(false);
	// Viewport class: ≤768px turns the side panels into sliding drawers
	// (matches the CSS breakpoint) — used to lazy-load panel data only when
	// a drawer is actually open on mobile.
	const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
	const rightMax = workspaceMaxPx({
		viewportPx: viewportW,
		leftPx: isMobile || leftCollapsed ? 0 : leftWidth,
		minPx: RIGHT_MIN,
		maxPx: RIGHT_MAX,
	});
	const rightWidthClamped = Math.min(rightWidth, rightMax);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(false);
	// Custom model config panel (model dropdown → 管理模型).
	const [manageModelsOpen, setManageModelsOpen] = useState(false);
	// Settings panel (system prompt / skills / extensions / presets).
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Wide chat column (client-local, default off).
	const wide = useWideChat();
	// Global search panel (sessions / projects / workspace files).
	const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
	/** 全局搜索「会话」结果点击后的跳转目标：切到该会话并定位到命中消息。
	 *  由 MessageList 消费（消息载入即跳转+高亮），跳完后置空。 */
	const [searchJump, setSearchJump] = useState<{
		path: string;
		role: string;
		timestamp: number;
	} | null>(null);
	// 兜底：跳转请求应在下次快照载入时即被 MessageList 消费；超过 15s 未消费
	//（用户中途切走会话等）则清空，避免陈旧目标挂起、日后误触发。
	useEffect(() => {
		if (!searchJump) return;
		const t = setTimeout(() => setSearchJump(null), 15_000);
		return () => clearTimeout(t);
	}, [searchJump]);

	// Ctrl+K / Cmd+K opens global search (also reachable via the topbar button).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
			e.preventDefault();
			setGlobalSearchOpen((v) => !v);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Remembers a terminal-view click made before the WebSocket is ready.
	const terminalOpenRequested = useRef(false);
	// Previous terminal list — drives the uninstall-finished watcher below.
	const prevTerminalsRef = useRef(chat.terminals);

	// Maintenance watcher: when a `pi remove …` command tab transitions
	// running → exited, re-discover extensions/skills.
	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		for (const tm of chat.terminals) {
			const cmd = tm.command?.command ?? "";
			const before = prev.find((p) => p.id === tm.id);
			if (!before?.running || tm.running) continue;
			if (cmd.startsWith("pi remove ") || cmd.startsWith("npm i -g ")) {
				send({ type: "extensions_reload" });
			}
		}
	}, [chat.terminals, send]);

	/** Switch an already-open page in place from a trusted click message. The
	 * message carries no URL and is accepted only for a conversation currently
	 * present in the server's roster, so an OS toast cannot trigger a fetch. */
	const pendingNotificationClickRef = useRef<string | null>(null);
	const processNotificationClick = useCallback(() => {
		const id = pendingNotificationClickRef.current;
		if (!id || !chat.conversations.some((conversation) => conversation.id === id)) return;
		if (id !== chat.activeConversationId && !send({ type: "switch_conversation", id })) return;
		pendingNotificationClickRef.current = null;
	}, [chat.activeConversationId, chat.conversations, send]);
	const handleNotificationClick = useCallback(
		(value: unknown) => {
			const id = parseNotificationClickMessage(value);
			if (!id) return;
			pendingNotificationClickRef.current = id;
			processNotificationClick();
		},
		[processNotificationClick],
	);

	// A click can race the initial roster push; retry the same validated message
	// when conversations arrive, without ever issuing a URL navigation/fetch.
	useEffect(() => {
		processNotificationClick();
	}, [processNotificationClick]);

	// Existing clients receive a postMessage/custom event and never reload. The
	// URL query path below is only for a newly opened client with no page to send.
	useEffect(() => {
		const onServiceWorkerMessage = (event: MessageEvent<unknown>) => handleNotificationClick(event.data);
		const onWindowNotificationClick = (event: Event) => handleNotificationClick((event as CustomEvent<unknown>).detail);
		navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
		window.addEventListener(NOTIFICATION_CLICK_EVENT, onWindowNotificationClick);
		return () => {
			navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
			window.removeEventListener(NOTIFICATION_CLICK_EVENT, onWindowNotificationClick);
		};
	}, [handleNotificationClick]);

	// Notification clicks carry only a conversation ID in the app URL. Wait for
	// the roster before validating it; never fetch or navigate to an unknown ID.
	useEffect(() => {
		const rawId = notificationConversationIdFromUrl(window.location.href);
		if (!rawId || !chat.ready) return;
		const availableIds = chat.conversations.map((conversation) => conversation.id);
		const id = resolveNotificationConversation(window.location.href, availableIds);
		if (id && id !== chat.activeConversationId && !send({ type: "switch_conversation", id })) return;
		const cleanedUrl = withoutNotificationConversationId(window.location.href);
		window.history.replaceState(window.history.state, "", cleanedUrl);
	}, [chat.activeConversationId, chat.conversations, chat.ready, chat.status, send]);

	const attach = (
		path: string,
		name: string,
		mode: "inline" | "reference" | "lines",
		isDir = false,
		lines?: { start: number; end: number },
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some((a) => `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` === key)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
	};
	const removeAttachment = (pathOrKey: string) =>
		setAttachments((prev) => prev.filter((a) => (a.key ? a.key !== pathOrKey : a.path !== pathOrKey)));

	// Side panels live in mobile drawers — any action inside them (session
	// switch, cwd change, file list…) should close the drawer. Stable wrapper
	// so RightPanel's polling effect doesn't churn (send is stable).
	const panelSend = useCallback(
		(msg: ClientMessage) => {
			// Only close the mobile drawer on an explicit navigation/action. Mounting
			// LeftPanel fires read-only list_* probes that must NOT collapse the
			// freshly-opened drawer (they run through panelSend too). Otherwise the
			// drawer opens and immediately snaps shut.
			if (!msg.type.startsWith("list_") && !msg.type.startsWith("get_")) {
				setDrawer(null);
			}
			return send(msg);
		},
		[send],
	);

	// -- pasted / dropped / uploaded images (no workspace path) ---------------
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	const attachImage = (img: ProcessedImage) => {
		// Warn when the current model can't see images — the image would still
		// be attached but silently ignored by the provider. Throttled so adding
		// several images at once produces one notice, not a stack.
		const now = Date.now();
		if (viewState?.model && !viewState.model.vision) {
			if (now - lastVisionWarn.current > 10000) {
				lastVisionWarn.current = now;
				pushNotice("warning", t("imageNotSupported"));
			}
		}
		const key = `paste-${++pasteImageId.current}`;
		setAttachments((prev) => [
			...prev,
			{
				path: "",
				key,
				name: img.name,
				mode: "inline",
				imageData: img.data,
				mimeType: img.mimeType,
			},
		]);
	};
	const addImageFiles = async (files: File[]) => {
		for (const f of files) {
			const img = await fileToProcessedImage(f);
			if (!img) {
				pushNotice("error", t("imageLoadFailed", { name: f.name }));
				continue;
			}
			attachImage(img);
		}
	};

	// -- dropped / uploaded files (any type, no workspace path) ---------------
	/** Keep in sync with MAX_UPLOAD_BYTES in agent-service.ts. */
	const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = async (f: File) => {
		if (f.size > MAX_UPLOAD_BYTES) {
			pushNotice("warning", t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }));
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushNotice("error", t("fileLoadFailed", { name: f.name }));
			return;
		}
		const key = `upload-${++uploadId.current}`;
		setAttachments((prev) => [
			...prev,
			{
				path: "",
				key,
				name: f.name,
				mode: "inline",
				fileData: base64,
				size: f.size,
				mimeType: f.type || undefined,
			},
		]);
	};
	const addLocalFiles = async (files: File[]) => {
		for (const f of files) {
			// Raster images go through the resize/encode pipeline (vision content);
			// everything else — including SVG — is uploaded raw and attached by path.
			if (isRasterImage(f.type)) {
				await addImageFiles([f]);
			} else {
				await attachLocalFile(f);
			}
		}
	};

	// Edit-and-re-ask: the server forks a new session at that message and re-asks
	// the edited text there (stable callback — Message is memoized). Attachments
	// carry the question's original images (fork drops their aside cards) plus
	// any newly pasted/dropped ones — same pipeline as a normal prompt.
	const onEditMessage = useCallback(
		(messageId: string, text: string, attachments?: PromptAttachment[]) => {
			send({ type: "edit_message", messageId, text, attachments });
		},
		[send],
	);

	// Remove one queued prompt (the ✕ on a pending bubble).
	const onRemoveQueued = useCallback(
		(kind: "steer" | "followUp", text: string) => {
			send({ type: "queue_remove", kind, text });
		},
		[send],
	);

	// 撤回一条排队/插队消息：先从队列移除（同 ✕ 的协议），再把文字放回输入框。
	// ChatInput 内部持有 text state，这里用数组递过去（seq 递增；数组保证连续点两条不丢第一条）。
	const [recallDrafts, setRecallDrafts] = useState<{ text: string; seq: number }[]>([]);
	const recallSeqRef = useRef(0);
	const onRecallQueued = useCallback(
		(kind: "steer" | "followUp", text: string) => {
			send({ type: "queue_remove", kind, text });
			recallSeqRef.current += 1;
			const item = { text, seq: recallSeqRef.current };
			setRecallDrafts((prev) => [...prev.slice(-9), item]);
		},
		[send],
	);

	// Stable callbacks for memoized panels (LeftPanel/RightPanel/ChatInput/
	// GoalBar skip re-render while tokens stream in — inline closures here
	// would break their shallow prop comparison every render).
	const openManageModels = useCallback(() => setManageModelsOpen(true), []);
	const clearAttachments = useCallback(() => setAttachments([]), []);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	const addImageFilesCb = useCallback(addImageFiles, [addImageFiles]);
	const addLocalFilesCb = useCallback(addLocalFiles, [addLocalFiles]);

	// Narrow snapshot of the model/thinking fields for the memoized ChatInput →
	// ModelThinking chain; identity is stable while tokens stream in.
	const currentSession = chat.sessionsByCwd.get(cwd)?.find((session) => session.path === viewState?.sessionFile);
	const conversationTitle =
		currentSession?.name ||
		chat.conversations.find((conversation) => conversation.id === chat.activeConversationId)?.title ||
		currentSession?.firstMessage.trim();

	// Dispatch agent role: parsed from the extension's CONFIRMED status bridge
	// (never the active model), and whether the extension is loaded at all.
	const activeAgent = parseAgentRole(chat.statuses);
	const agentAvailable = hasDispatchExtension(chat.slashCommands);

	const model = viewState?.model;
	const thinkingLevel = viewState?.thinkingLevel;
	const availableThinkingLevels = viewState?.availableThinkingLevels;
	const modelState = useMemo(
		() =>
			model
				? {
						model,
						thinkingLevel: thinkingLevel ?? "off",
						availableThinkingLevels: availableThinkingLevels ?? [],
					}
				: null,
		// Deps are the STABLE inner refs (server reuses them across snapshots),
		// so the object identity survives token deltas and ChatInput's memo holds.
		[model, thinkingLevel, availableThinkingLevels],
	);

	const createShell = useCallback(() => {
		if (!chat.ready || chat.terminals.length !== 0) return false;
		terminal.create({
			id: randomUuid(),
			conversationId: chat.activeConversationId || chat.state?.conversationId || "",
			title: t("terminalTitle", { n: 1 }),
			cwd: chat.state?.cwd ?? "",
			cols: 80,
			rows: 24,
			running: true,
			exitCode: null,
		});
		return true;
	}, [chat.ready, chat.state?.cwd, chat.terminals.length, t, terminal]);

	/** Open (not toggle) the bottom terminal strip — used by SCM/panel "go to
	 *  terminal" flows; reuses the same shell-creation rule. */
	const openBottomTerminal = useCallback(() => {
		setEverBottom(true);
		if (chat.terminals.length === 0 && !createShell()) {
			terminalOpenRequested.current = true;
		} else {
			terminalOpenRequested.current = false;
		}
		setBottomTerminalOpen(true);
	}, [chat.terminals.length, createShell]);

	// Toggle the bottom terminal strip. The first shell is created on the user's
	// terminal click, not on initial mount; if the session is still connecting,
	// remember the request and complete it once ready. Shell creation is a side
	// effect and must stay OUT of the state updater: React StrictMode can invoke
	// updaters twice, which would spawn duplicate PTYs. The event handler path
	// (openBottomTerminal) owns the once-only creation.
	const toggleBottomTerminal = useCallback(() => {
		if (bottomTerminalOpen) {
			setBottomTerminalOpen(false);
			return;
		}
		openBottomTerminal();
	}, [bottomTerminalOpen, openBottomTerminal]);

	/** Running delegated workers — the Workers tab shows the count. */
	const activeWorkers = (viewState?.workers ?? EMPTY_WORKERS).filter(
		(w) => w.status === "starting" || w.status === "running",
	).length;

	/** Open (and focus) a workspace panel tab. */
	const openWorkspace = useCallback((tab: WorkspaceTab) => {
		setWorkspaceOpen(true);
		setWorkspaceTab(tab);
	}, []);
	const openTodos = useCallback(() => {
		// Keep the current tab intact while placing the session section in view;
		// its shared shell means this also works for the mobile workspace overlay.
		setWorkspaceOpen(true);
		setTodoFocusRequest((request) => request + 1);
	}, []);

	// Message lists kept mounted: the displayed conversation plus the most
	// recently viewed cached ones. Keyed by conversation id, so a switch only
	// toggles `hidden` on the wrappers; ids that leave the cache (dismissed
	// conversations, LRU eviction) unmount.
	const currentId = viewState?.conversationId ?? null;
	const slotIds = useMemo(
		() => recentConversationIds(currentId, chat.snapshotsById, KEEP_MOUNTED),
		[currentId, chat.snapshotsById],
	);
	const onJumpDone = useCallback(() => setSearchJump(null), []);
	// A requested new chat puts the caret in the composer at once (the same
	// window event the welcome cards use — ChatInput owns the textarea).
	const newChatSeq = chat.optimisticNewChat?.seq ?? 0;
	useEffect(() => {
		if (newChatSeq > 0) window.dispatchEvent(new CustomEvent("pi-web:focus-composer"));
	}, [newChatSeq]);

	// If the user clicked Terminal while the initial connection was still
	// loading, complete that request as soon as the session becomes ready.
	useEffect(() => {
		if (!terminalOpenRequested.current) return;
		if (!bottomTerminalOpen || chat.terminals.length !== 0) {
			terminalOpenRequested.current = false;
			return;
		}
		if (createShell()) terminalOpenRequested.current = false;
	}, [chat.terminals.length, createShell, bottomTerminalOpen]);

	// A delegate card asked for the Workers pane (detail = worker id, or null
	// for the lists). Window event: the card is deep in the memoized tree.
	useEffect(() => {
		const onOpen = (e: Event) => {
			const id = (e as CustomEvent<number | null>).detail;
			setSelectedWorker(typeof id === "number" ? id : null);
			openWorkspace("workers");
		};
		window.addEventListener(OPEN_WORKER_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_WORKER_EVENT, onOpen);
	}, [openWorkspace]);

	// Workspace / bottom-terminal keyboard shortcuts: Ctrl+P files,
	// Ctrl+Shift+G git review, Ctrl+Shift+L workers (Ctrl+Shift+W closes the
	// browser window), Ctrl+` bottom terminal.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			const key = e.key.toLowerCase();
			const isShift = e.shiftKey;
			if (key === "p" && !isShift) {
				e.preventDefault();
				openWorkspace("files");
			} else if (key === "g" && isShift) {
				e.preventDefault();
				openWorkspace("git");
			} else if (key === "l" && isShift) {
				e.preventDefault();
				openWorkspace("workers");
			} else if (key === "`") {
				e.preventDefault();
				toggleBottomTerminal();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openWorkspace, toggleBottomTerminal]);

	return (
		// Whole window is a drop target (issue #19): dragover highlights + any
		// drop attaches. The plain preventDefault used to merely stop the browser
		// navigating away; children with their own handlers (input bar / edit
		// composer) call stopPropagation and keep priority.
		<div
			className="app"
			onDragOver={(e) => {
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				setAppDragOver(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setAppDragOver(false);
			}}
			onDrop={(e) => {
				setAppDragOver(false);
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				const files = Array.from(e.dataTransfer?.files ?? []);
				if (files.length === 0) {
					pushNotice("warning", t("foldersNotSupported"));
					return;
				}
				// Same split as ChatInput.handleFiles: raster images go through
				// the vision pipeline, everything else uploads as a raw file.
				const images = files.filter((f) => isRasterImage(f.type));
				const others = files.filter((f) => !isRasterImage(f.type));
				if (images.length > 0) void addImageFiles(images);
				if (others.length > 0) void addLocalFiles(others);
			}}
		>
			{appDragOver && (
				<div className="app-drop-overlay" aria-hidden>
					<span>📎 {t("dropHereToAttach")}</span>
				</div>
			)}
			{chat.protocolMismatch && <div className="protocol-banner">⚠ {t("protocolMismatch")}</div>}
			<div className="notices">
				{chat.notices.map((n) => (
					<NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />
				))}
			</div>
			<div className="astra-body" style={{ "--left-w": `${leftWidth}px` } as CSSProperties}>
				{drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />}
				{!isMobile && leftCollapsed && <PanelRail side="left" onClick={toggleLeft} />}
				<div
					className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}${isMobile ? "" : leftCollapsed ? " hidden" : ""}`}
				>
					<LeftPanel
						onOpenGlobalSearch={() => {
							setDrawer(null);
							setGlobalSearchOpen(true);
						}}
						collapsible={!isMobile}
						onToggleCollapse={toggleLeft}
						panelSend={panelSend}
						active={!isMobile || drawer === "left"}
						sessionFile={viewState?.sessionFile ?? null}
						conversations={chat.conversations}
						sessionsByCwd={chat.sessionsByCwd}
						projects={chat.projects}
						activeConversationId={chat.activeConversationId}
						worktreeResult={chat.worktreeResult}
					/>
				</div>
				{!isMobile && <ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />}
				<div className="astra-column">
					<AstraHeader
						chat={{ ready: chat.ready, status: chat.status, state: viewState }}
						title={conversationTitle}
						onOpenPanel={() => setDrawer("left")}
						onOpenSettings={() => setSettingsOpen(true)}
						onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
						workspaceOpen={workspaceOpen}
						onToggleWorkspace={toggleWorkspace}
						bottomTerminalOpen={bottomTerminalOpen}
						onToggleBottomTerminal={toggleBottomTerminal}
					/>
					<div className="astra-row" style={{ "--right-w": `${rightWidthClamped}px` } as CSSProperties}>
						<main className={wide ? "main wide-chat" : "main"}>
							{viewState ? (
								slotIds.map((id) => {
									const isCurrent = id === currentId;
									const slotState = isCurrent ? viewState : chat.snapshotsById.get(id);
									if (!slotState) return null;
									// Only the visible list gets live props; parked ones hold
									// their cached snapshot (reference-stable → memo rows idle).
									return (
										<div key={id} className="chat-slot" hidden={!isCurrent}>
											<MessageList
												state={slotState}
												active={isCurrent}
												liveOutputs={isCurrent ? chat.liveOutputs : EMPTY_LIVE}
												toolStatuses={isCurrent ? chat.toolStatuses : EMPTY_STATUSES}
												onEdit={onEditMessage}
												onKillBash={() => send({ type: "abort_bash" })}
												onRetry={() => {
													if (send({ type: "retry_last" })) {
														const m = viewState.model;
														if (m) recordModelUsage(`${m.provider}/${m.id}`);
													}
												}}
												onRemoveQueued={onRemoveQueued}
												onRecallQueued={onRecallQueued}
												thinkingWrap={chat.settings?.thinkingWrap ?? true}
												toolsWrap={chat.settings?.toolsWrap ?? false} // Astra 默认折叠摘要；错误卡自动展开，对话框不受影响
												jumpTarget={isCurrent ? searchJump : null}
												onJumpDone={onJumpDone}
											/>
										</div>
									);
								})
							) : (
								<div className="boot-wait">{chat.ready ? t("loadingSession") : t("connectingServer")}</div>
							)}
							{/* 扩展问卷：非模态内联面板，插在输入框上方 */}
							{chat.dialog && <Dialog dialog={chat.dialog} />}
							{chat.question && <QuestionDialog question={chat.question} />}
							{/* pi-todo: tasks the current run touched, mirroring the CLI overlay above the editor */}
							<TodoStrip todos={chat.todos} onViewAll={openTodos} />
							<ChatInput
								streaming={viewState?.isStreaming ?? false}
								booting={blocked}
								messages={viewState?.messages ?? EMPTY_MESSAGES}
								slashCommands={chat.slashCommands}
								modelState={modelState}
								contextUsage={viewState?.stats.contextUsage}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								projects={chat.projects}
								worktreeResult={chat.worktreeResult}
								providerKeys={chat.providerKeys}
								attachments={attachments}
								onRemoveAttachment={removeAttachmentCb}
								onAddImageFiles={addImageFilesCb}
								onAddLocalFiles={addLocalFilesCb}
								onNotice={pushNotice}
								onManageModels={openManageModels}
								onSent={clearAttachments}
								activeAgent={activeAgent}
								agentAvailable={agentAvailable}
								recallDrafts={recallDrafts}
							/>
						</main>
						{workspaceOpen && (
							<>
								{!isMobile && (
									<ResizeHandle
										side="right"
										width={rightWidthClamped}
										min={RIGHT_MIN}
										max={rightMax}
										reset={defaultWorkspaceWidth}
										onResize={resizeRight}
									/>
								)}
								<aside className={`astra-workspace${isMobile ? " overlay" : ""}`} aria-label={t("astraWorkspace")}>
									<TodoPanel todos={chat.todos} focusRequest={todoFocusRequest} />
									<div className="astra-workspace-tabs" role="tablist" aria-label={t("astraWorkspace")}>
										{workspaceTab !== null && (
											<button
												type="button"
												className="astra-workspace-back"
												title={t("astraWorkspace")}
												aria-label={t("astraWorkspace")}
												onClick={() => setWorkspaceTab(null)}
											>
												<FiArrowLeft />
											</button>
										)}
										<button
											type="button"
											role="tab"
											aria-selected={workspaceTab === "files"}
											className={workspaceTab === "files" ? "active" : ""}
											onClick={() => setWorkspaceTab("files")}
										>
											<FiFolder />
											<span>{t("astraFiles")}</span>
										</button>
										{tabOn("git") && (
											<button
												type="button"
												role="tab"
												aria-selected={workspaceTab === "git"}
												className={workspaceTab === "git" ? "active" : ""}
												onClick={() => setWorkspaceTab("git")}
											>
												<FiGitBranch />
												<span>{t("astraReview")}</span>
											</button>
										)}
										<button
											type="button"
											role="tab"
											aria-selected={workspaceTab === "workers"}
											className={workspaceTab === "workers" ? "active" : ""}
											onClick={() => setWorkspaceTab("workers")}
										>
											<FiUsers />
											<span>{t("astraWorkers")}</span>
											{activeWorkers > 0 && <span className="astra-workspace-badge">{activeWorkers}</span>}
										</button>
										{tabOn("tasks") && (
											<button
												type="button"
												role="tab"
												aria-selected={workspaceTab === "background"}
												className={workspaceTab === "background" ? "active" : ""}
												onClick={() => setWorkspaceTab("background")}
											>
												<FiServer />
												<span>{t("astraBackground")}</span>
												{chat.bgServers.length > 0 && (
													<span className="astra-workspace-badge">{chat.bgServers.length}</span>
												)}
											</button>
										)}
										<button
											type="button"
											className="astra-workspace-close"
											title={t("close")}
											onClick={() => setWorkspaceOpen(false)}
										>
											<FiX />
										</button>
									</div>
									<div className="astra-workspace-content">
										{workspaceTab === null && (
											<div className="astra-workspace-chooser" role="menu">
												<div className="astra-workspace-hint">{t("astraWorkspaceHint")}</div>
												<button
													type="button"
													role="menuitem"
													className="astra-workspace-item"
													onClick={() => setWorkspaceTab("files")}
												>
													<FiFolder />
													<span>{t("astraFiles")}</span>
													<kbd>Ctrl+P</kbd>
												</button>
												{tabOn("git") && (
													<button
														type="button"
														role="menuitem"
														className="astra-workspace-item"
														onClick={() => setWorkspaceTab("git")}
													>
														<FiGitBranch />
														<span>{t("astraReview")}</span>
														<kbd>Ctrl+Shift+G</kbd>
													</button>
												)}
												<button
													type="button"
													role="menuitem"
													className="astra-workspace-item"
													onClick={() => setWorkspaceTab("workers")}
												>
													<FiUsers />
													<span>{t("astraWorkers")}</span>
													<kbd>Ctrl+Shift+L</kbd>
												</button>
												{tabOn("tasks") && (
													<button
														type="button"
														role="menuitem"
														className="astra-workspace-item"
														onClick={() => setWorkspaceTab("background")}
													>
														<FiServer />
														<span>{t("astraBackground")}</span>
													</button>
												)}
												<button
													type="button"
													role="menuitem"
													className={`astra-workspace-item${bottomTerminalOpen ? " active" : ""}`}
													onClick={toggleBottomTerminal}
												>
													<FiTerminal />
													<span>{t("terminal")}</span>
													<kbd>Ctrl+`</kbd>
												</button>
											</div>
										)}
										{workspaceTab === "files" && (
											<RightPanel
												collapsible={false}
												panelSend={panelSend}
												files={chat.files}
												fileChanged={chat.fileChanged}
												widgets={chat.widgets}
												onAttach={(path, name, mode, isDir) => attach(path, name, mode, isDir)}
												onPreview={(path, name) => setWorkspaceFile({ path, name })}
												onNotice={(level, text) => pushNotice(level, text)}
											/>
										)}
										{workspaceTab === "git" && (
											<div className="astra-workspace-pane">
												<ScmPanel chat={chat} terminal={terminal} active onSwitchToTerminal={openBottomTerminal} />
											</div>
										)}
										{workspaceTab === "workers" && (
											<div className="astra-workspace-pane">
												<WorkersPanel
													workers={viewState?.workers ?? EMPTY_WORKERS}
													transcripts={chat.workerTranscripts}
													conversationId={viewState?.conversationId}
													selected={selectedWorker}
													onSelect={setSelectedWorker}
													send={send}
													thinkingWrap={chat.settings?.thinkingWrap ?? true}
													toolsWrap={chat.settings?.toolsWrap ?? false}
												/>
											</div>
										)}
										{workspaceTab === "background" && tabOn("tasks") && (
											<div className="astra-workspace-pane">
												<BackgroundPanel servers={chat.bgServers} send={send} />
											</div>
										)}
										{workspaceTab === "files" && workspaceFile && (
											<FilePreview
												inline
												file={workspaceFile}
												content={chat.fileContent}
												onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
												onAttach={(path, name, mode) => attach(path, name, mode)}
												onClose={() => setWorkspaceFile(null)}
											/>
										)}
									</div>
									<SubscriptionUsage clientId={getClientId()} ready={chat.ready && chat.status === "open"} />
								</aside>
							</>
						)}
					</div>
					<section className={`astra-bottom-terminal${bottomTerminalOpen ? "" : " closed"}`} aria-label={t("terminal")}>
						{everBottom && (
							<Suspense fallback={null}>
								<TerminalPanel chat={chat} terminal={terminal} />
							</Suspense>
						)}
					</section>
				</div>
			</div>
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
				/>
			)}
			{chat.ready && chat.state && chat.state.piConfigured === false && !setupDismissed && !manageModelsOpen && (
				<PiSetupModal
					piConfigured={chat.state.piConfigured}
					piAgentInstalled={chat.state.piAgentInstalled}
					providers={chat.providers}
					installResult={chat.installResult}
					onClose={() => setSetupDismissed(true)}
				/>
			)}
			{manageModelsOpen && (
				<ModelConfigModal
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					providerKeys={chat.providerKeys}
					fetchModelsResult={chat.fetchModelsResult}
					cloneProviderResult={chat.cloneProviderResult}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					terminal={terminal}
					onSwitchToTerminal={openBottomTerminal}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
			<GlobalSearchModal
				open={globalSearchOpen}
				projects={chat.projects}
				fileSearch={chat.fileSearch}
				sessionSearch={chat.sessionSearch}
				onClose={() => setGlobalSearchOpen(false)}
				onSwitchSession={(path, anchors) => {
					void send({ type: "switch_session", path });
					// 跳到命中消息位置（锚点取自服务端返回；无锚点则只切换会话）
					const a = anchors && anchors[0];
					setSearchJump(a ? { path, role: a.role, timestamp: a.timestamp } : null);
				}}
				onSwitchProject={(path) => {
					void send({ type: "set_cwd", path });
				}}
				onPreviewFile={(path, name) => {
					setPreviewFile({ path, name });
				}}
			/>
		</div>
	);
}
