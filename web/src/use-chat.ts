import { useCallback, useEffect, useReducer, useRef } from "react";
import { randomUuid } from "./uuid";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";
import type {
	ClientMessage,
	BgServer,
	CommandDef,
	ConversationSummary,
	FileContent,
	FileListing,
	FileSearchResult,
	ModelInfo,
	ProjectSummary,
	ProviderKeyInfo,
	ProviderStatus,
	ServerMessage,
	TodosState,
	SessionSearchResult,
	SessionSummary,
	SlashCommandInfo,
	ToolStatus,
	TerminalInfo,
	UiModelConfigEntry,
	UiPendingQuestion,
	UiProviderConfig,
	UiServiceInfo,
	UiSettingsState,
	UiState,
	UiWorkerTranscript,
} from "./types";

/** The payload of a `worktree_result` server message. */
export type WorktreeResult = Extract<ServerMessage, { type: "worktree_result" }>;

import { applyMessageDelta, type MessageDeltaMsg } from "./message-delta";
import { resolvePendingQuestion, type QuestionSource } from "./pending-question";
import { cwdKey } from "./components/left-panel-nav";
import { setAppGlobals, setAppSend } from "./app-globals";
import { setWorkers } from "./workers-store";
import { formatNotificationEvent, isNotificationEvent, notificationEventKey } from "./notification-events";
import { notify } from "./notify";
import { PROTOCOL_VERSION } from "./protocol-version";
import {
	OPTIMISTIC_TIMEOUT_MS,
	cacheSnapshot,
	pruneSnapshots,
	sendBlocked,
	syntheticNewChat,
} from "./conversation-view";

export type ConnStatus = "connecting" | "open" | "closed";

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
	textEn?: string;
}

/** A terminal tab. The output stream itself lives in the xterm instance
 * (via the terminal bridge) — this is just the tab metadata. */
export interface TerminalMeta extends TerminalInfo {
	conversationId: string;
}

export interface ChatState {
	status: ConnStatus;
	/** True once the server confirmed the agent session is ready (hello processed). */
	ready: boolean;
	state: UiState | null;
	/** Live tool output accumulated from tool_delta messages, keyed by toolCallId. */
	liveOutputs: Map<string, { toolName: string; text: string }>;
	/**
	 * Tools that FINISHED executing (tool_status from tool_execution_end), keyed
	 * by toolCallId. Lets the card show "done · waiting for the model" even
	 * while the session is still streaming. Cleared once the toolResult message
	 * lands in the snapshot (it carries the authoritative result).
	 */
	toolStatuses: Map<string, ToolStatus>;
	notices: Notice[];
	serverVersion?: string;
	/** PI_WEB_MANAGED=1 on the server: updates and plugin installs come from
	 *  whoever deploys this instance, so the interface does not offer them.
	 *  The server refuses those messages regardless (server/managed.ts). */
	/** pi-web-ui's own version, from `ready`. `serverVersion` is the pi SDK's,
	 *  and the update check — the client's other source — does not run on a
	 *  managed instance. */
	appVersion?: string;
	managed?: boolean;
	/** PI_WEB_TABS on the server: the tabs this instance offers. Undefined
	 *  means all of them, which is the default. */
	tabs?: string[];
	/** Persisted session lists, keyed by the project cwd they belong to
	 *  (the server echoes the queried cwd on every `sessions` push). */
	sessionsByCwd: Map<string, SessionSummary[]>;
	/** Open conversations (each runs its own session in parallel). */
	conversations: ConversationSummary[];
	/** Id of the conversation the current snapshot belongs to. */
	activeConversationId: string;
	/** Recent workspaces this client opened (left panel project picker). */
	projects: ProjectSummary[];
	/** Latest worktree_add / worktree_remove outcome (monotonic `seq` so a
	 *  repeat of the same outcome is still observed). Consumed by the left
	 *  panel (dirty-removal confirm) and the composer (creating state). */
	worktreeResult: (WorktreeResult & { seq: number }) | null;
	/** Workspace file listing for the right panel. */
	files: FileListing | null;
	/** Latest file content fetched for the preview panel (path-matched in the modal). */
	fileContent: FileContent | null;

	/** Last dir-changed push from the server fs.watch (path = listed directory). */
	fileChanged: { path: string } | null;
	/** Models with valid auth, for the model dropdown. */
	models: ModelInfo[];
	/** True while a model list request is in flight. */
	modelsLoading: boolean;
	/** Custom providers from agentDir/models.json (model config panel). */
	modelsConfig: UiProviderConfig[];
	/** Built-in providers with auth status (key-only config). */
	providers: ProviderStatus[];
	/** Stored API keys per built-in provider (masked), for multi-key grouping. */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** Result of the last install_pi_agent run (null while not started/running). */
	installResult: { ok: boolean; detail: string } | null;
	/** Path completions for the cwd input. */
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	/** Extension widgets (TUI overlays bridged to the web UI). */
	widgets: { key: string; lines: string[] }[];
	/** Extension footer statuses (setStatus bridge). */
	statuses: { key: string; text: string | undefined }[];
	/** Structured todo list of the active conversation (pi-todo bridge). */
	todos: TodosState;
	/** Active extension dialog (select/confirm/input) awaiting a response. */
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
	} | null;
	/** 待用户回答的模型提问（ask_user_question）——两个引擎共用。服务端是事实源：
	 *  即时通道（question_pending）+ 快照（UiState.pendingQuestion，见 syncPendingQuestion）。 */
	question: UiPendingQuestion | null;
	/** User command list from .pi/commands.json (terminal left panel). */
	commands: CommandDef[];
	commandsPath: string;
	/** Slash-command catalog for the chat input (builtin + extension +
	 *  template + skill). */
	slashCommands: SlashCommandInfo[];
	/** Open terminal tabs (metadata only; streams go through the bridge). */
	terminals: TerminalMeta[];
	/** Terminal the SCM/settings panel asked to focus (auto-switch on write ops). */
	terminalActiveId: string | null;
	/** Settings-panel state (system prompt, skill/extension toggles, presets). */
	settings: UiSettingsState | null;
	/** AI-started background servers (managed from the 后台任务 panel). The
	 *  list lives on the client session, so it survives conversation ends. */
	bgServers: BgServer[];
	/** Last fetch_models probe result (custom-provider model list), matched by
	 *  reqId in the model config modal. */
	fetchModelsResult: {
		reqId: number;
		ok: boolean;
		models?: UiModelConfigEntry[];
		error?: string;
	} | null;
	/** Last refresh_provider_models result (saved-provider list refresh). */
	refreshProviderResult: {
		reqId: number;
		ok: boolean;
		added?: number;
		total?: number;
		error?: string;
	} | null;
	/** Last clone_provider result (built-in → custom draft for the model
	 *  config modal to open pre-filled). */
	cloneProviderResult: {
		reqId: number;
		ok: boolean;
		config?: UiProviderConfig;
		configs?: UiProviderConfig[];
		error?: string;
	} | null;
	/** Last source-control query result (scm_status / scm_filediff /
	 *  scm_commit), matched by reqId in the SCM panel. */
	scmData: ServerMessage | null;
	/** Last global-search file query result, matched by reqId in the
	 *  global search panel (stale results with older reqIds are ignored). */
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	/** Last global-search conversation-content query result (server-side
	 *  transcript match, AI output included) — same reqId discipline. */
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	/** Increments when the server reports the watched git dir changed
	 *  outside the panel — SCMPanel refreshes on change while visible. */
	scmDirty: number;
	/** Server wire-protocol version differs from ours — the page was loaded
	 *  before/after an app update; show a persistent refresh banner. */
	protocolMismatch: boolean;
	/** Transcripts of the delegated workers the Workers pane follows
	 *  (open_worker → worker_transcript pushes), keyed by worker id. Scoped to
	 *  the ACTIVE conversation: cleared whenever the snapshot switches chats. */
	workerTranscripts: Map<number, UiWorkerTranscript>;
	/** Client-only: a new chat was requested and the server has not answered
	 *  yet. `view` is the synthetic empty UiState App renders meanwhile (see
	 *  conversation-view.ts for the whole state machine); `seq` lets the
	 *  safety timeout tell one request from the next. */
	optimisticNewChat: { cwd: string | null; view: UiState; seq: number } | null;
	/** Client-only: conversation the user switched to; its cached snapshot
	 *  (if any) is already displayed while the server's snapshot is on its
	 *  way. Sends are blocked until then. */
	switchPending: string | null;
	/** Latest snapshot per open conversation (LRU, newest last) — the instant
	 *  view on switch and the state fed to the kept-mounted message lists. */
	snapshotsById: Map<string, UiState>;
}

export type ChatAction =
	| { type: "status"; status: ConnStatus }
	| { type: "snapshot"; state: UiState }
	| { type: "snapshot_delta"; msg: Extract<ServerMessage, { type: "snapshot_delta" }> }
	| { type: "protocol_mismatch" }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
	| { type: "message_delta"; msg: MessageDeltaMsg }
	| { type: "tool_status"; status: ToolStatus }
	| { type: "notice"; notice: Notice }
	| { type: "dismiss_notice"; id: number }
	| {
			type: "ready";
			serverVersion: string;
			protocolVersion?: number;
			appVersion?: string;
			managed?: boolean;
			tabs?: string[];
			service?: UiServiceInfo;
	  }
	| { type: "sessions"; cwd: string; sessions: SessionSummary[] }
	| {
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	| { type: "worktree_result"; result: WorktreeResult }
	| { type: "files"; files: FileListing }
	| { type: "file_changed"; path: string }
	| { type: "file_content"; content: FileContent }
	| { type: "models"; models: ModelInfo[]; loading: boolean }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	| {
			type: "fetch_models_result";
			result: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string };
	  }
	| {
			type: "refresh_provider_result";
			result: { reqId: number; ok: boolean; added?: number; total?: number; error?: string };
	  }
	| {
			type: "clone_provider_result";
			result: { reqId: number; ok: boolean; config?: UiProviderConfig; configs?: UiProviderConfig[]; error?: string };
	  }
	| { type: "scm_data"; data: ServerMessage }
	| {
			type: "file_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: FileSearchResult[];
				truncated?: boolean;
			};
	  }
	| {
			type: "session_search_result";
			result: {
				reqId: number;
				ok: boolean;
				results: SessionSearchResult[];
			};
	  }
	| { type: "scm_changed" }
	| { type: "worker_transcript"; conversationId: string; transcript: UiWorkerTranscript }
	| { type: "install_result"; result: { ok: boolean; detail: string } }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| { type: "todos"; todos: TodosState }
	| {
			type: "dialog";
			dialog: {
				id: number;
				kind: "select" | "confirm" | "input";
				title: string;
				args: unknown[];
			} | null;
	  }
	| {
			type: "question";
			question: UiPendingQuestion | null;
	  }
	| { type: "commands"; commands: CommandDef[]; path: string }
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "terminal_add"; meta: TerminalMeta }
	| { type: "terminal_remove"; id: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_restart"; terminalId: string }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	| { type: "terminal_active"; id: string }
	| { type: "settings"; settings: UiSettingsState }
	| { type: "bg_servers"; servers: BgServer[] }
	| { type: "optimistic_new_chat"; cwd: string | null }
	| { type: "optimistic_timeout"; seq: number }
	| { type: "switch_conversation"; id: string }
	| { type: "switch_timeout"; id: string };

const MAX_LIVE_OUTPUT = 200_000;
const MAX_TERM_BUFFER = 200_000;
/** Marker for truncated live output (was "…[前 N 字符已省略]…" / "…[N chars omitted above]…").
 *  ToolCallBlock maps it through the liveOutputOmitted i18n key so only one language shows. */
const LIVE_OMIT_MARK = "LIVE_OMIT";

/**
 * Bridges terminal output from the socket to live xterm instances. Output for
 * a terminal whose component isn't mounted yet (or that this tab doesn't know
 * about) is buffered (capped) so nothing is lost during mount/reconnect.
 */
interface TerminalWriter {
	write: (data: string) => void;
	dispose: () => void;
}

function makeTerminalBridge() {
	/** Multiple writers may subscribe to the same (conversation, terminal) pair —
	 *  e.g. the SCM panel's hidden query terminal parses output through its own
	 *  writer while a (hidden) xterm instance may also be registered for it.
	 *  A Set keeps them all: later registrations no longer shadow earlier ones. */
	const writers = new Map<string, Set<TerminalWriter>>();
	const buffers = new Map<string, string>();
	const key = (conversationId: string, terminalId: string) => `${conversationId}:${terminalId}`;
	return {
		write(conversationId: string, terminalId: string, data: string): void {
			const writerKey = key(conversationId, terminalId);
			const set = writers.get(writerKey);
			if (set && set.size > 0) {
				for (const w of set) {
					try {
						w.write(data);
					} catch {
						// best effort
					}
				}
				return;
			}
			const prev = buffers.get(writerKey) ?? "";
			const next = prev.length + data.length > MAX_TERM_BUFFER ? data : prev + data;
			buffers.set(writerKey, next);
		},
		/** Register a writer (xterm instance / output parser); flushes buffered
		 *  output to the new subscriber. Returns an unregister fn. */
		register(conversationId: string, terminalId: string, writer: TerminalWriter): () => void {
			const writerKey = key(conversationId, terminalId);
			let set = writers.get(writerKey);
			if (!set) {
				set = new Set();
				writers.set(writerKey, set);
			}
			set.add(writer);
			const buffered = buffers.get(writerKey);
			if (buffered) {
				try {
					writer.write(buffered);
				} catch {
					// best effort
				}
				buffers.delete(writerKey);
			}
			return () => {
				const s = writers.get(writerKey);
				if (s) {
					s.delete(writer);
					if (s.size === 0) writers.delete(writerKey);
				}
				buffers.delete(writerKey);
			};
		},
		clear(): void {
			writers.clear();
			buffers.clear();
		},
	};
}

function pruneLiveOutputs(
	live: Map<string, { toolName: string; text: string }>,
	state: UiState,
): Map<string, { toolName: string; text: string }> {
	const completed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) completed.add(m.toolCallId);
		// bashExecution transcript messages supersede live bash deltas
		if (m.role === "bashExecution") completed.add(`bash-${m.id}`);
	}
	let changed = false;
	for (const id of live.keys()) {
		if (completed.has(id)) {
			live.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(live) : live;
}

/** Drop tool_status entries once the authoritative toolResult message lands.
 *  Builds the landed-id Set once (O(messages)) instead of scanning all
 *  messages per status entry (was O(statuses × messages) every snapshot). */
function pruneToolStatuses(statuses: Map<string, ToolStatus>, state: UiState): Map<string, ToolStatus> {
	if (statuses.size === 0) return statuses;
	const landed = new Set<string>();
	for (const m of state.messages) {
		if (m.role === "toolResult" && m.toolCallId) landed.add(m.toolCallId);
	}
	let changed = false;
	for (const id of statuses.keys()) {
		if (landed.has(id)) {
			statuses.delete(id);
			changed = true;
		}
	}
	return changed ? new Map(statuses) : statuses;
}

/** Exported for the unit tests (pure; StrictMode double-invokes it). */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case "status":
			return {
				...state,
				status: action.status,
				// A new socket is not ready until its hello/ready round-trip completes.
				ready: action.status === "open" ? state.ready : false,
				// PTYs are conversation-owned and survive socket reconnects. Clear only
				// the browser views so xterm writers remount when the server replays them.
				terminals: action.status === "closed" ? [] : state.terminals,
			};
		case "ready":
			return {
				...state,
				serverVersion: action.serverVersion,
				appVersion: action.appVersion,
				managed: action.managed === true,
				tabs: action.tabs,
				ready: true,
				// Old page + new server (or the reverse) after an in-place update:
				// WS handling on either side may be stale — banner asks for refresh.
				protocolMismatch: action.protocolVersion !== undefined && action.protocolVersion !== PROTOCOL_VERSION,
			};
		case "snapshot":
			return {
				...state,
				ready: true,
				state: action.state,
				activeConversationId: action.state.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, action.state),
				toolStatuses: pruneToolStatuses(state.toolStatuses, action.state),
				// Another chat's followed workers are meaningless here; the pane
				// re-opens the selected one after the switch.
				workerTranscripts:
					state.state?.conversationId === action.state.conversationId ? state.workerTranscripts : new Map(),
				// Any snapshot settles a pending click: the server switched (new
				// chat / target conversation) or re-snapshotted the old one after
				// a failure — either way what it sent is what we show.
				optimisticNewChat: null,
				switchPending: null,
				snapshotsById: cacheSnapshot(state.snapshotsById, action.state),
			};
		case "snapshot_delta": {
			// Incremental checkpoint from the server. Apply ONLY when it chains
			// cleanly onto our current rev; a mismatch (dropped message under
			// backpressure, stale tab) is ignored here — the ws handler schedules
			// a get_state resync. Immutable merge: appended messages extend the
			// array (element references preserved → React memo keeps working);
			// light fields replace wholesale.
			const ui = state.state;
			const d = action.msg;
			if (!ui || ui.conversationId !== d.conversationId || ui.rev !== d.baseRev) {
				// Not the displayed conversation (a switch is in flight and the
				// server still streams the old one): keep its cache entry fresh
				// when the delta chains onto it, so switching back is exact.
				const cached = state.snapshotsById.get(d.conversationId);
				if (!cached || cached.rev !== d.baseRev) return state;
				const mergedCached: UiState = {
					...cached,
					...d.state,
					messages: d.appended.length > 0 ? [...cached.messages, ...d.appended] : cached.messages,
				};
				return { ...state, snapshotsById: cacheSnapshot(state.snapshotsById, mergedCached) };
			}
			const merged: UiState = {
				...ui,
				...d.state,
				messages: d.appended.length > 0 ? [...ui.messages, ...d.appended] : ui.messages,
			};
			return {
				...state,
				ready: true,
				state: merged,
				activeConversationId: merged.conversationId,
				liveOutputs: pruneLiveOutputs(state.liveOutputs, merged),
				toolStatuses: pruneToolStatuses(state.toolStatuses, merged),
				snapshotsById: cacheSnapshot(state.snapshotsById, merged),
			};
		}
		case "optimistic_new_chat": {
			// Empty chat NOW; the server's snapshot (success: the new chat,
			// failure: the old one + a notice) clears it. Nothing to derive from
			// before the first snapshot — the boot-wait placeholder stays.
			const view = syntheticNewChat(state.state, action.cwd);
			if (!view) return state;
			return {
				...state,
				optimisticNewChat: { cwd: action.cwd, view, seq: (state.optimisticNewChat?.seq ?? 0) + 1 },
				switchPending: null,
				// Sidebar: nothing active until the server names the new chat.
				activeConversationId: "",
			};
		}
		case "optimistic_timeout":
			if (!state.optimisticNewChat || state.optimisticNewChat.seq !== action.seq) return state;
			return {
				...state,
				optimisticNewChat: null,
				activeConversationId: state.state?.conversationId ?? state.activeConversationId,
			};
		case "switch_conversation": {
			if (state.state?.conversationId === action.id && !state.optimisticNewChat) return state;
			const cached = state.snapshotsById.get(action.id);
			// A cached snapshot paints at once (the server's confirms it later);
			// without one only the row highlight moves and sends are held.
			return {
				...state,
				optimisticNewChat: null,
				switchPending: action.id,
				activeConversationId: action.id,
				...(cached
					? {
							state: cached,
							workerTranscripts: state.state?.conversationId === action.id ? state.workerTranscripts : new Map(),
						}
					: {}),
			};
		}
		case "switch_timeout":
			if (state.switchPending !== action.id) return state;
			return {
				...state,
				switchPending: null,
				activeConversationId: state.state?.conversationId ?? state.activeConversationId,
			};
		case "tool_delta": {
			const prev = state.liveOutputs.get(action.toolCallId);
			// Keep the TAIL when over the cap (not the head): for a long-running
			// tool what matters is the LATEST output — keeping the head would show
			// only the earliest 200K chars and freeze visually while the tool is
			// still streaming. The terminal-bridge buffer below already keeps the
			// newest data; this unifies the semantics.
			const text = (prev?.text ?? "") + action.delta;
			const capped =
				text.length > MAX_LIVE_OUTPUT
					? `…[${LIVE_OMIT_MARK}:${text.length - MAX_LIVE_OUTPUT}]…\n` + text.slice(text.length - MAX_LIVE_OUTPUT)
					: text;
			const liveOutputs = new Map(state.liveOutputs);
			liveOutputs.set(action.toolCallId, {
				toolName: action.toolName,
				text: capped,
			});
			return { ...state, liveOutputs };
		}
		case "message_delta": {
			const ui = state.state;
			// Server only streams the active conversation, but filter defensively:
			// a late delta for another conversation must not clobber this view.
			if (!ui || ui.conversationId !== action.msg.conversationId) return state;
			// applyMessageDelta is pure/immutable (StrictMode double-invokes reducers).
			return { ...state, state: applyMessageDelta(ui, action.msg) };
		}
		case "tool_status":
			return {
				...state,
				toolStatuses: new Map(state.toolStatuses).set(action.status.toolCallId, action.status),
			};
		case "notice":
			return { ...state, notices: [...state.notices, action.notice].slice(-6) };
		case "dismiss_notice":
			return {
				...state,
				notices: state.notices.filter((n) => n.id !== action.id),
			};
		case "sessions": {
			const sessionsByCwd = new Map(state.sessionsByCwd);
			// One directory, one list: a refresh echoed under another spelling of
			// the same Windows path (c:/... vs C:/...) must replace the stale one,
			// not sit beside it - otherwise a deleted transcript keeps showing.
			const key = cwdKey(action.cwd);
			for (const k of [...sessionsByCwd.keys()]) if (cwdKey(k) === key) sessionsByCwd.delete(k);
			sessionsByCwd.set(action.cwd, action.sessions);
			return { ...state, sessionsByCwd };
		}
		case "conversations":
			return {
				...state,
				conversations: action.conversations,
				// A pending click owns the highlight until a snapshot settles it
				// (this list may still name the conversation we just left).
				activeConversationId: state.optimisticNewChat
					? ""
					: state.switchPending !== null
						? state.switchPending
						: action.activeId,
				snapshotsById: pruneSnapshots(state.snapshotsById, action.conversations),
			};
		case "projects":
			return { ...state, projects: action.projects };
		case "worktree_result":
			return {
				...state,
				worktreeResult: { ...action.result, seq: (state.worktreeResult?.seq ?? 0) + 1 },
				// A refused checkout never opens a chat — no snapshot will follow.
				optimisticNewChat: action.result.op === "add" && !action.result.ok ? null : state.optimisticNewChat,
				activeConversationId:
					action.result.op === "add" && !action.result.ok && state.optimisticNewChat
						? (state.state?.conversationId ?? state.activeConversationId)
						: state.activeConversationId,
			};
		case "files":
			return { ...state, files: action.files };
		case "file_changed":
			return { ...state, fileChanged: { path: action.path } };
		case "file_content":
			return { ...state, fileContent: action.content };
		case "models":
			return { ...state, models: action.models, modelsLoading: action.loading };
		case "models_config":
			return { ...state, modelsConfig: action.providers };
		case "providers_status":
			return { ...state, providers: action.providers };
		case "provider_keys":
			return { ...state, providerKeys: action.keys };
		case "fetch_models_result":
			return { ...state, fetchModelsResult: action.result };
		case "refresh_provider_result":
			return { ...state, refreshProviderResult: action.result };
		case "clone_provider_result":
			return { ...state, cloneProviderResult: action.result };
		case "install_result":
			return { ...state, installResult: action.result };
		case "scm_data":
			return { ...state, scmData: action.data };
		case "file_search_result":
			return { ...state, fileSearch: action.result };
		case "session_search_result":
			return { ...state, sessionSearch: action.result };
		case "scm_changed":
			return { ...state, scmDirty: state.scmDirty + 1 };
		case "worker_transcript": {
			if (state.state?.conversationId !== action.conversationId) return state;
			const workerTranscripts = new Map(state.workerTranscripts);
			workerTranscripts.set(action.transcript.workerId, action.transcript);
			return { ...state, workerTranscripts };
		}
		case "path_completions":
			return { ...state, pathCompletions: action.completions };
		case "widgets":
			return { ...state, widgets: action.widgets };
		case "statuses":
			return { ...state, statuses: action.statuses };
		case "todos":
			return { ...state, todos: action.todos };
		case "dialog":
			return { ...state, dialog: action.dialog };
		case "question":
			return { ...state, question: action.question };
		case "commands":
			return {
				...state,
				commands: action.commands,
				commandsPath: action.path,
			};
		case "slash_commands":
			return { ...state, slashCommands: action.commands };
		case "settings":
			return { ...state, settings: action.settings };
		case "bg_servers":
			return { ...state, bgServers: action.servers };
		case "terminal_add":
			return { ...state, terminals: [...state.terminals, action.meta] };
		case "terminal_remove":
			return {
				...state,
				terminals: state.terminals.filter((t) => t.id !== action.id),
			};
		case "terminal_exit":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			)
				return state;
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: false, exitCode: action.exitCode } : t,
				),
			};
		case "terminal_restart":
			// The command is re-running in the same tab (server restarted the PTY).
			return {
				...state,
				terminals: state.terminals.map((t) =>
					t.id === action.terminalId ? { ...t, running: true, exitCode: null } : t,
				),
			};
		case "terminal_list":
			if (
				action.conversationId &&
				(state.activeConversationId || state.state?.conversationId) &&
				action.conversationId !== (state.activeConversationId || state.state?.conversationId)
			) {
				return state;
			}
			return {
				...state,
				terminals: action.terminals.map((terminal) => ({
					...terminal,
					conversationId: action.conversationId ?? state.state?.conversationId ?? "",
				})),
			};
		case "terminal_active":
			return { ...state, terminalActiveId: action.id };
		default:
			return state;
	}
}

const CLIENT_ID_KEY = "pi-web-client-id";
let cachedClientId: string | null = null;

/**
 * 客户端标识 —— **每标签页独立**（sessionStorage 而非 localStorage）。
 *
 * 曾用 localStorage：同源所有标签页共享同一 clientId，后端把它们挂到同一个
 * ClientSession 上互为镜像——B 标签页切换对话会同步切走 A 页、甚至把 A 页
 * 正在输出的 agent 强制中断且状态持久化（issue #10）。改为 sessionStorage 后
 * 新开标签页即新客户端；刷新本页仍保留同一 id，client-state（最近项目等）不丢。
 */
export function getClientId(): string {
	if (cachedClientId) return cachedClientId;
	let id: string | null = null;
	try {
		id = sessionStorage.getItem(CLIENT_ID_KEY);
		if (!id) {
			id = randomUuid();
			sessionStorage.setItem(CLIENT_ID_KEY, id);
		}
	} catch {
		// storage 不可用（隐私模式等）：退化为页面生命周期内的一次性 id
		id = id ?? randomUuid();
	}
	cachedClientId = id;
	return id;
}

/**
 * 上次成功工作目录（localStorage，跨浏览器重启记忆）——解决「每次打开浏览器都
 * 回默认目录」：clientId 在 sessionStorage（每标签页独立，issue #10），浏览器
 * 整个关闭后 sessionStorage 清空 → 新 clientId 在服务端 client-state 里查不到
 *  lastCwd → 落回默认目录。这里用 localStorage 单独记住最近一次成功的工作目录
 * （只存一个路径字符串，不涉及客户端身份），首帧快照时若服务端落在其他目录则
 * 补发 set_cwd 切回。
 */
const LAST_CWD_KEY = "pi-web-last-cwd";

/** Read the last-used working directory remembered across browser restarts. */
export function readLastCwd(): string | null {
	try {
		return localStorage.getItem(LAST_CWD_KEY);
	} catch {
		return null;
	}
}

function writeLastCwd(cwd: string): void {
	try {
		localStorage.setItem(LAST_CWD_KEY, cwd);
	} catch {
		/* storage 不可用（隐私模式等）：忽略，仅本次会话生效 */
	}
}

/** Resolve the WebSocket URL: same host when served by the backend, or the Vite proxy in dev. */
function wsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	// appUrl 补应用根前缀：子路径反代（/pi/）下 WS 也必须走 /pi/ws。
	return withToken(`${proto}//${location.host}${appUrl("/ws")}`);
}

/** Fresh reducer state (before the socket opens). */
export function initialChatState(): ChatState {
	return {
		status: "connecting",
		ready: false,
		state: null,
		liveOutputs: new Map(),
		toolStatuses: new Map(),
		notices: [],
		sessionsByCwd: new Map(),
		conversations: [],
		activeConversationId: "",
		projects: [],
		worktreeResult: null,
		files: null,

		fileChanged: null,
		fileContent: null,
		models: [],
		modelsLoading: false,
		modelsConfig: [],
		providers: [],
		providerKeys: {},
		installResult: null,
		pathCompletions: [],
		widgets: [],
		statuses: [],
		todos: { tasks: [], nextId: 1, runIds: [], running: false },
		dialog: null,
		question: null,
		commands: [],
		commandsPath: "",
		slashCommands: [],
		terminals: [],
		terminalActiveId: null,
		bgServers: [],
		settings: null,
		fetchModelsResult: null,
		refreshProviderResult: null,
		cloneProviderResult: null,
		scmData: null,
		fileSearch: null,
		sessionSearch: null,
		scmDirty: 0,
		protocolMismatch: false,
		workerTranscripts: new Map(),
		optimisticNewChat: null,
		switchPending: null,
		snapshotsById: new Map(),
	};
}

export function useChat() {
	const [chat, dispatch] = useReducer(chatReducer, undefined, initialChatState);
	const wsRef = useRef<WebSocket | null>(null);
	/** Terminal output bridge (writers keyed by terminalId). */
	const bridgeRef = useRef(makeTerminalBridge());
	/** Reconnect backoff counter — ref so it never causes re-renders. */
	const retryRef = useRef(0);
	/** Pending reconnect timer. */
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** False once the hook is unmounted/cleaned up — stops stale onclose handlers from reconnecting. */
	const aliveRef = useRef(true);
	/** Last time any server message arrived — used to detect half-open connections. */
	const lastBeatRef = useRef(0);
	const noticeId = useRef(0);
	/** Last delta seq seen per conversation (message_delta + tool_delta share
	 *  one per-conversation sequence) — a gap on the ACTIVE conversation
	 *  triggers a one-shot get_state resync; background conversations converge
	 *  via snapshot when switched to. */
	const lastDeltaSeqRef = useRef<Map<string, number>>(new Map());
	const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** 跨重启工作目录记忆：restoreRef 只允许首帧快照发起一次恢复；lastCwdRef
	 *  避免对同一目录重复写 localStorage。 */
	const restoreRef = useRef(false);
	const lastCwdRef = useRef<string | null>(null);

	/** 已作答/取消的问卷 id —— 在途旧快照不得把已答过的问卷重新弹出来。
	 *  id 全局单调递增（服务端 questionSeq / 时间戳），保留少量历史即可。 */
	const answeredQuestionsRef = useRef<Set<string>>(new Set());
	/** 当前问卷面板的来源：live = question_pending 即时通道弹出；snapshot = 由快照
	 *  恢复（重连/刷新）。只有 snapshot 来源的才接受快照收起（见 syncPendingQuestion）。 */
	const questionSourceRef = useRef<QuestionSource>("live");

	/** Debounced authoritative resync: get_state always returns a FULL snapshot.
	 *  Shared by delta-seq gap detection and snapshot_delta rev mismatch. */
	const scheduleResync = (): void => {
		if (resyncTimerRef.current) return;
		resyncTimerRef.current = setTimeout(() => {
			resyncTimerRef.current = null;
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN)
				ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
		}, 300);
	};

	const noteDeltaSeq = (conversationId: string, seq: number): void => {
		const map = lastDeltaSeqRef.current;
		const last = map.get(conversationId);
		if (last !== undefined && seq !== last + 1) {
			const c = chatApi.current.chat;
			const active = c.activeConversationId || c.state?.conversationId;
			if (conversationId === active) {
				// Missed deltas (should not happen on a healthy WS) — resync via a
				// debounced get_state; keep patching meanwhile (the next snapshot
				// reconciles any drift).
				scheduleResync();
			}
		}
		map.set(conversationId, seq);
	};

	const pushNotice = useCallback((level: Notice["level"], text: string) => {
		const id = ++noticeId.current;
		dispatch({ type: "notice", notice: { id, level, text } });
		// 自动消失计时由通知组件（NoticeToast）管理：悬浮暂停、移开继续。
	}, []);

	/** Raw socket send (no client-side side effects) — `send` below wraps it. */
	const sendRaw = useCallback((msg: ClientMessage) => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
			// 提交/取消模型提问后立即收起对话框：服务端只 resolve 模型侧 Promise，
			// 不会发任何回执清除前端面板（否则会出现“回答后不消失、取消无效”）。
			// 模型再次 ask_user_question 时会重新 question_pending，面板自动回来。
			if (msg.type === "question_answer") {
				// 记住这个 id：快照恢复时跳过它（回答消息与快照在途时会交错，服务端
				// 删除 pending 之前生成的快照仍带着这张问卷）。
				answeredQuestionsRef.current.add(msg.id);
				if (answeredQuestionsRef.current.size > 64) {
					const oldest = answeredQuestionsRef.current.values().next().value;
					if (oldest !== undefined) answeredQuestionsRef.current.delete(oldest);
				}
				questionSourceRef.current = "live";
				dispatch({ type: "question", question: null });
			}
			return true;
		}
		return false;
	}, []);

	/** Start a new chat (top button, project head, /new, worktree flows):
	 *  the empty view paints now, the server boots the runtime meanwhile. */
	const newChat = useCallback((cwd: string | null | undefined) => {
		if (!sendRaw({ type: "new_chat", cwd: cwd ?? null })) return false;
		dispatch({ type: "optimistic_new_chat", cwd: cwd ?? null });
		return true;
	}, []);

	/** Switch to an open conversation: its cached snapshot (if any) paints
	 *  now, the server's snapshot confirms it. Sends are held meanwhile. */
	const switchConversation = useCallback((id: string) => {
		if (!sendRaw({ type: "switch_conversation", id })) return false;
		dispatch({ type: "switch_conversation", id });
		return true;
	}, []);

	/** Every outgoing message funnels through here (appSend included), so
	 *  the optimistic paths cover callers that only hold a send function:
	 *  the sidebar's new-chat buttons, the worktree pill, a typed "/new". */
	const send = useCallback((msg: ClientMessage): boolean => {
		switch (msg.type) {
			case "new_chat":
				return newChat(msg.cwd);
			case "switch_conversation":
				return switchConversation(msg.id);
			case "worktree_add": {
				// The chat opens in the checkout once git is done; until then
				// the empty view sits on the project cwd (the pill shows it as
				// creating). A refused add clears it via worktree_result.
				if (!sendRaw(msg)) return false;
				dispatch({ type: "optimistic_new_chat", cwd: msg.cwd ?? null });
				return true;
			}
			case "prompt": {
				if (!/^\/new(\s|$)/.test(msg.text.trim())) return sendRaw(msg);
				if (!sendRaw(msg)) return false;
				dispatch({ type: "optimistic_new_chat", cwd: null });
				return true;
			}
			default:
				return sendRaw(msg);
		}
	}, []);

	/** 快照里的待答问卷 → 恢复/收起对话框（页面刷新、WS 重连、新标签页）。
	 *
	 *  为什么需要它：question_pending 是即时通道，只推给「提问那一刻在线」的连接；
	 *  刷新/重连后前端拿不到那条历史消息，而服务端还在阻塞等人回答——问卷就从眼前
	 *  消失（DshQuestionDialog 无入口）。快照是权威态，据此把面板补回来。
	 *  判定规则（含两条防闪烁/防赖着的边界）全在纯函数 resolvePendingQuestion。 */
	const syncPendingQuestion = useCallback((p: UiPendingQuestion | null | undefined) => {
		const decision = resolvePendingQuestion({
			current: chatApi.current.chat.question,
			source: questionSourceRef.current,
			snapshot: p,
			answered: answeredQuestionsRef.current,
		});
		if (!decision.changed) return;
		questionSourceRef.current = decision.source;
		dispatch({ type: "question", question: decision.question });
	}, []);

	// 装配全局发送器（web/src/app-globals.ts 的 appSend）：**在 render 期间**赋值，不用 effect。
	// 子组件的 effect 先于父组件跑，若放到 effect 里装配，那些「挂载即发请求」的弹窗
	// （PiSetupModal / ModelConfigModal / TerminalPanel …）会在 appSend 还是空的时候发消息，
	// 静默丢包。send 是 useCallback([]) 的稳定引用，重复赋值无副作用（StrictMode 双渲染亦然）。
	setAppSend(send);

	/** Stable across renders — the reconnect loop lives entirely inside this closure. */
	const connect = useCallback(() => {
		if (!aliveRef.current) return;
		dispatch({ type: "status", status: "connecting" });
		const ws = new WebSocket(wsUrl());
		wsRef.current = ws;

		ws.onopen = () => {
			if (wsRef.current !== ws) return; // stale socket
			dispatch({ type: "status", status: "open" });
			retryRef.current = 0;
			lastBeatRef.current = Date.now();
			ws.send(
				JSON.stringify({
					type: "hello",
					clientId: getClientId(),
				} satisfies ClientMessage),
			);
		};

		ws.onmessage = (ev) => {
			if (wsRef.current !== ws) return; // stale socket
			lastBeatRef.current = Date.now(); // any traffic proves the connection is alive
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data as string) as ServerMessage;
			} catch {
				return;
			}
			switch (msg.type) {
				case "notification_event": {
					// This is an edge-triggered live event. It intentionally does not
					// derive notifications from snapshots, so reconnects cannot replay it.
					const event = msg;
					if (isNotificationEvent(event)) {
						const copy = formatNotificationEvent(event);
						void notify(copy.title, copy.body, {
							eventKey: notificationEventKey(event),
							conversationId: event.conversationId,
						});
					}
					break;
				}
				case "ready":
					// Global runtime facts (managed / tabs / versions) land here once,
					// synchronously before dispatch, so components reading the globals
					// see the right values on the very next render. See app-globals.ts.
					setAppGlobals({
						managed: !!msg.managed,
						tabs: msg.tabs,
						appVersion: msg.appVersion,
						serverVersion: msg.serverVersion,
						service: msg.service,
					});
					dispatch({
						type: "ready",
						serverVersion: msg.serverVersion,
						protocolVersion: msg.protocolVersion,
						appVersion: msg.appVersion,
						managed: msg.managed,
						tabs: msg.tabs,
						service: msg.service,
					});
					// Ensure a fresh snapshot on (re)connect.
					ws.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
					// Sessions + recent projects are LAZY: LeftPanel requests them
					// when it is actually shown — listing scans every session file
					// on disk (listAll scans ALL projects), too heavy for the
					// connect critical path.
					ws.send(JSON.stringify({ type: "list_files" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "list_commands" } satisfies ClientMessage));
					ws.send(JSON.stringify({ type: "get_commands" } satisfies ClientMessage));
					break;
				case "snapshot":
					// Snapshot is authoritative — delta sequence tracking restarts.
					lastDeltaSeqRef.current = new Map();
					dispatch({ type: "snapshot", state: msg.state });
					// 重连/刷新后从这里把待答问卷恢复出来（见 syncPendingQuestion）。
					syncPendingQuestion(msg.state.pendingQuestion);
					break;
				case "snapshot_delta": {
					// Gap detection BEFORE dispatch: if this incremental checkpoint
					// doesn't chain onto our current rev (a message was dropped under
					// backpressure, or we're stale), schedule one debounced full resync.
					// While a click is in flight the displayed state is deliberately
					// not the server's active conversation — its confirming snapshot
					// reconciles everything, no resync needed.
					const c = chatApi.current.chat;
					const cur = c.state;
					const pending = c.switchPending !== null || c.optimisticNewChat !== null;
					if (!pending && (!cur || cur.conversationId !== msg.conversationId || cur.rev !== msg.baseRev))
						scheduleResync();
					dispatch({ type: "snapshot_delta", msg });
					// A delta for the conversation we just left must not pop its
					// questionnaire over the one we switched to.
					if (!pending || cur?.conversationId === msg.conversationId) syncPendingQuestion(msg.state.pendingQuestion);
					break;
				}
				case "tool_delta":
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({
						type: "tool_delta",
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						delta: msg.delta,
					});
					break;
				case "tool_status":
					dispatch({ type: "tool_status", status: msg });
					break;
				case "message_delta": {
					noteDeltaSeq(msg.conversationId, msg.seq);
					dispatch({ type: "message_delta", msg });
					break;
				}
				case "notice": {
					const id = ++noticeId.current;
					dispatch({
						type: "notice",
						notice: { id, level: msg.level, text: msg.text, textEn: msg.textEn },
					});
					break;
				}
				case "sessions": {
					// Old servers / engines omit cwd — attribute to the current
					// project (backward compatible with the unscoped payload).
					const cwd = msg.cwd ?? chatApi.current.chat.state?.cwd ?? "";
					dispatch({ type: "sessions", cwd, sessions: msg.sessions });
					break;
				}
				case "conversations":
					dispatch({
						type: "conversations",
						conversations: msg.conversations,
						activeId: msg.activeId,
					});
					break;
				case "projects":
					dispatch({ type: "projects", projects: msg.projects });
					break;
				case "worktree_result":
					dispatch({ type: "worktree_result", result: msg });
					break;
				case "files":
					dispatch({ type: "files", files: msg });
					break;
				case "file_changed":
					dispatch({ type: "file_changed", path: msg.path });
					break;
				case "file_content":
					dispatch({ type: "file_content", content: msg });
					break;
				case "models":
					dispatch({ type: "models", models: msg.models, loading: false });
					break;
				case "models_config":
					dispatch({ type: "models_config", providers: msg.providers });
					break;
				case "providers_status":
					dispatch({ type: "providers_status", providers: msg.providers });
					break;
				case "provider_keys":
					dispatch({ type: "provider_keys", keys: msg.keys });
					break;
				case "fetch_models_result":
					dispatch({
						type: "fetch_models_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							models: msg.models,
							error: msg.error,
						},
					});
					break;
				case "refresh_provider_result":
					dispatch({
						type: "refresh_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							added: msg.added,
							total: msg.total,
							error: msg.error,
						},
					});
					break;
				case "clone_provider_result":
					dispatch({
						type: "clone_provider_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							config: msg.config,
							configs: (msg as { configs?: UiProviderConfig[] }).configs,
							error: msg.error,
						},
					});
					break;
				case "scm_data":
					dispatch({ type: "scm_data", data: msg });
					break;
				case "search_files_result":
					dispatch({
						type: "file_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
							truncated: msg.truncated,
						},
					});
					break;
				case "session_search_results":
					dispatch({
						type: "session_search_result",
						result: {
							reqId: msg.reqId,
							ok: msg.ok,
							results: msg.results,
						},
					});
					break;
				case "scm_changed":
					dispatch({ type: "scm_changed" });
					break;
				case "worker_transcript":
					dispatch({ type: "worker_transcript", conversationId: msg.conversationId, transcript: msg.transcript });
					break;
				case "install_result":
					dispatch({ type: "install_result", result: msg });
					break;
				case "path_completions":
					dispatch({ type: "path_completions", completions: msg.completions });
					break;
				case "widgets":
					dispatch({ type: "widgets", widgets: msg.widgets });
					break;
				case "statuses":
					dispatch({ type: "statuses", statuses: msg.statuses });
					break;
				case "todos": {
					const { type: _t, ...todos } = msg;
					dispatch({ type: "todos", todos });
					break;
				}
				case "dialog":
					dispatch({
						type: "dialog",
						dialog: {
							id: msg.id,
							kind: msg.kind,
							title: msg.title,
							args: msg.args,
						},
					});
					break;
				case "dialog_closed":
					dispatch({ type: "dialog", dialog: null });
					break;
				case "question_pending":
					questionSourceRef.current = "live";
					dispatch({
						type: "question",
						question: {
							id: msg.id,
							...(msg.deadline !== undefined ? { deadline: msg.deadline } : {}),
							questions: msg.questions,
						},
					});
					break;
				case "terminal_output":
					bridgeRef.current.write(
						msg.conversationId ?? chatApi.current.chat.activeConversationId,
						msg.terminalId,
						msg.data,
					);
					break;
				case "terminal_exit":
					dispatch({
						type: "terminal_exit",
						conversationId: msg.conversationId,
						terminalId: msg.terminalId,
						exitCode: msg.exitCode,
					});
					break;
				case "terminal_list":
					dispatch({
						type: "terminal_list",
						conversationId: msg.conversationId,
						terminals: msg.terminals,
					});
					break;
				case "commands":
					dispatch({
						type: "commands",
						commands: msg.commands,
						path: msg.path,
					});
					break;
				case "slash_commands":
					dispatch({ type: "slash_commands", commands: msg.commands });
					break;
				case "settings_state":
					dispatch({ type: "settings", settings: msg.settings });
					break;
				case "bg_servers":
					dispatch({ type: "bg_servers", servers: msg.servers });
					break;
				default:
					break;
			}
		};

		ws.onclose = () => {
			if (wsRef.current === ws) wsRef.current = null;
			// Terminals died with the server-side PTYs — drop writers/buffers.
			bridgeRef.current.clear();
			// Cleanup closed this socket on purpose — do not reconnect.
			if (!aliveRef.current) return;
			// A newer socket already took over (e.g. a StrictMode remount raced
			// this socket's close) — do not spawn a third connection that would
			// shadow the live one and drop its incoming messages.
			if (wsRef.current && wsRef.current !== ws) return;
			dispatch({ type: "status", status: "closed" });
			// Reconnect with exponential backoff (1s → 2s → 4s → … capped at 10s).
			const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
			retryRef.current += 1;
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				connect();
			}, delay);
		};

		ws.onerror = () => {
			// onclose fires after onerror, triggering reconnect.
			// Do NOT call ws.close() here: it's redundant and causes a browser
			// warning "WebSocket is closed before the connection is established"
			// when the connection is still in CONNECTING state.
		};
	}, []);

	// Mount once; all reconnection is self-contained in `connect`.
	useEffect(() => {
		aliveRef.current = true;
		connect();
		// Watchdog: if no server message arrives for 30s, assume the connection is
		// half-open and force a close, which triggers the normal reconnect path.
		const watchdog = setInterval(() => {
			if (!aliveRef.current) return;
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastBeatRef.current > 30_000) {
				ws.close();
			}
		}, 5_000);
		return () => {
			aliveRef.current = false;
			clearInterval(watchdog);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [connect]);

	// -- 跨浏览器重启：恢复上次工作目录（localStorage 记忆） ---------------------
	// 服务端按 clientId 记 lastCwd，而 clientId 在 sessionStorage（关浏览器即失），
	// 重启后新 clientId 查不到记录 → 落回默认目录。这里在首帧快照上：若服务端
	// 当前目录 ≠ 记忆目录，补发 set_cwd 切回；此后每次 cwd 变化都写回记忆。
	useEffect(() => {
		const cwd = chat.state?.cwd;
		if (!cwd) return;
		if (!restoreRef.current) {
			restoreRef.current = true;
			const remembered = readLastCwd();
			if (remembered && remembered !== cwd) {
				// 记忆目录存在则服务端切换后会推新快照；不存在则服务端报错通知，
				// 保持默认目录——两种结果都不回写记忆，等用户下次操作再更新。
				send({ type: "set_cwd", path: remembered });
				return;
			}
		}
		if (lastCwdRef.current !== cwd) {
			lastCwdRef.current = cwd;
			writeLastCwd(cwd);
		}
	}, [chat.state?.cwd, send]);

	// -- 全局镜像：连接态 + 当前工作目录 -----------------------------------------
	// 这三个值整棵树都要（左栏/输入框/右栏/全局搜索/底栏…）且变化频率低，放全局 store
	// 省掉逐层传参（见 web/src/app-globals.ts）。用 effect 单一写入：值就是 reducer
	// 里的真值，不会出现第二个 source of truth；最多晚一帧（对应默认值只会是
	//「未就绪 / 未连接 / 空目录」，用户看不出）。
	// The cwd mirrored is the DISPLAYED one: an optimistic new chat aimed at
	// another project must highlight that project (sidebar) and show its
	// checkout (worktree pill) right away.
	const viewState = chat.optimisticNewChat?.view ?? chat.state;
	useEffect(() => {
		setAppGlobals({ ready: chat.ready, status: chat.status, cwd: viewState?.cwd ?? "" });
	}, [chat.ready, chat.status, viewState?.cwd]);
	/** Whether the composer may send: false while the displayed conversation
	 *  is a client-side guess (optimistic new chat / cached switch) or the
	 *  server's booting preview. */
	const blocked = sendBlocked({
		booting: viewState?.booting,
		optimistic: chat.optimisticNewChat !== null,
		switchPending: chat.switchPending,
	});

	// Safety timeouts (same 15 s as LeftPanel's pendingTarget): a click whose
	// snapshot never comes must not leave the composer locked forever.
	const optimisticSeq = chat.optimisticNewChat?.seq ?? 0;
	useEffect(() => {
		if (optimisticSeq === 0) return;
		const t = setTimeout(() => dispatch({ type: "optimistic_timeout", seq: optimisticSeq }), OPTIMISTIC_TIMEOUT_MS);
		return () => clearTimeout(t);
	}, [optimisticSeq]);
	const switchPending = chat.switchPending;
	useEffect(() => {
		if (switchPending === null) return;
		const t = setTimeout(() => dispatch({ type: "switch_timeout", id: switchPending }), OPTIMISTIC_TIMEOUT_MS);
		return () => clearTimeout(t);
	}, [switchPending]);
	// Delegated workers mirror for the delegate tool cards (workers-store.ts):
	// the store dedups by content, so the cards only re-render on real change.
	useEffect(() => {
		setWorkers(chat.state?.workers);
	}, [chat.state?.workers]);

	const dismissNotice = useCallback((id: number) => dispatch({ type: "dismiss_notice", id }), []);

	// -- terminal tab management ----------------------------------------------

	const terminalCreate = useCallback((meta: TerminalMeta) => dispatch({ type: "terminal_add", meta }), []);
	const terminalClose = useCallback((id: string) => dispatch({ type: "terminal_remove", id }), []);
	const terminalRestart = useCallback((id: string) => dispatch({ type: "terminal_restart", terminalId: id }), []);

	const terminalSelect = useCallback((id: string) => dispatch({ type: "terminal_active", id }), []);
	const terminalRegister = useCallback(
		(conversationId: string, id: string, writer: TerminalWriter) =>
			bridgeRef.current.register(conversationId, id, writer),
		[],
	);

	const chatApi = useRef({
		chat,
		/** The UiState to render: the optimistic empty chat while one is
		 *  requested, else the server's snapshot. */
		viewState,
		/** Composer lock (see conversation-view.ts sendBlocked). */
		blocked,
		send,
		newChat,
		switchConversation,
		pushNotice,
		dismissNotice,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	});
	chatApi.current = {
		chat,
		viewState,
		blocked,
		send,
		newChat,
		switchConversation,
		pushNotice,
		dismissNotice,
		terminal: {
			create: terminalCreate,
			close: terminalClose,
			register: terminalRegister,
			restart: terminalRestart,
			select: terminalSelect,
		},
	};
	return chatApi.current;
}
