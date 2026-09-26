/**
 * AgentService — wraps the pi SDK (@earendil-works/pi-coding-agent) for the web
 * frontend. Each browser client (identified by a persistent clientId) gets its
 * own AgentSessionRuntime, but sessions live in the SDK default per-project
 * directory (<agentDir>/sessions/--<cwd>--/) — the same transcript files the
 * pi CLI/TUI use — so every conversation of a folder shows up everywhere.
 *
 * Streaming model: the SDK emits AgentSessionEvents; we forward lightweight
 * `tool_delta` messages for live tool output and schedule throttled full-state
 * snapshots. The frontend is snapshot-driven (server is the source of truth),
 * so reconnects just re-request a snapshot.
 */
// MUST be the first import: rewrites the SDK's installed remote-catalog
// provider so built-in model lists follow the official pi.dev catalog
// wholesale (no union merge / no stale built-in leftovers).
import "./patch-remote-catalog.js";
// Same rule: rewrites the SDK's extension loader before it is first imported.
import "./patch-extension-cache.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, statSync, mkdirSync, watch } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	createLocalBashOperations,
	getAgentDir,
	SessionManager,
	VERSION,
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionUIContext,
	type SessionInfo,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BgServerTracker } from "./bg-servers.js";
import {
	createWorktree,
	generateWorktreeName,
	isManagedWorktree,
	listWorktrees,
	removeWorktree,
	sameWorktreePath,
	worktreeIsDirty,
	WorktreeError,
	type GitWorktree,
} from "./worktrees.js";
import { removeFirstOccurrence } from "./queue-utils.js";
import { SettingsService } from "./settings-service.js";
import { SlashCommandsService, parseSlash } from "./slash-commands.js";
import { ModelAdminService } from "./model-admin.js";
import { subscriptionUsage } from "./subscriptions.js";
import { FilesService, MACHINE_ROOT, workspacePath } from "./files-service.js";
import {
	isExtensionDisabled,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type PromptMode,
	ClientStateStore,
} from "./client-state.js";
import { resolveServerLang, type ServerLang } from "./i18n.js";

import {
	applyHeadTail,
	makePersistentTerminalTools,
	makeTerminalBashTool,
	stripAnsi,
	TERMINAL_TOOLS_GUIDANCE,
} from "./terminals.js";
import {
	applyAgentToolsGating,
	ASK_USER_QUESTION_TOOL_NAME,
	effectiveDisabledAgentTools,
	isTerminalGuidanceOn,
} from "./tool-manager.js";
import { ConversationStatuses, WebUIContext, type StatusEntry } from "./webui-context.js";
import { ConversationTodos, EMPTY_TODOS, TODO_TOOL_NAME } from "./todo-state.js";
import { decodeText } from "./text-sniff.js";
import { buildAttachmentMessages } from "./attachments.js";
import {
	BUILTIN_SOUL,
	DEFAULT_PROMPT_TEMPLATE,
	buildToolsSchemaText,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";
import type {
	CommandDef,
	ConversationSummary,
	MessageAnchor,
	ProjectSummary,
	QuestionAnswer,
	ServerMessage,
	SessionSummary,
	UiMessage,
	UiQuestion,
	UiServiceInfo,
	UiState,
} from "./protocol.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import { serializeStreamingMessage, stripTransientRetryErrors, type AgentMessage } from "./serialize.js";
import { loadCommands, saveCommandsFile, TerminalManager } from "./terminals.js";
import {
	buildPreviewState,
	newSerializeCache,
	serializeCachedInto,
	serializeTranscript,
	type SerializeCache,
} from "./session-preview.js";
import { isBridgeEvent, WORKER_CHANNEL, WorkerHub } from "./workers.js";
import { makeInputRequiredNotification, NotificationLifecycle } from "./notification-lifecycle.js";

const SNAPSHOT_INTERVAL_MS = 60;
/** While assistant deltas are flowing, live rendering is carried by
 *  message_delta — full snapshots become pure reconciliation checkpoints, so
 *  send them on a slow event-driven cadence (see flushSnapshot call-sites:
 *  agent_end / tool_execution_end always checkpoint immediately). */
const STREAMING_SNAPSHOT_INTERVAL_MS = 2000;
/** Deltas newer than this keep the streaming (low-frequency) snapshot cadence. */
const DELTA_ACTIVE_WINDOW_MS = 1500;
const WIDGET_REFRESH_MS = 2000;
/** Model-stall watchdog: warn (don't abort — deep thinking can be legitimately
 *  quiet for minutes) when a streaming run produced NO SDK events for this long.
 *  Covers the failure class the per-tool watchdog cannot see: half-open API
 *  connections / hung proxies where no tool is running and no error is thrown.
 *  Override: PI_WEB_STALL_NOTIFY_MS (milliseconds; 0 disables). */
const STALL_NOTIFY_MS = (() => {
	const v = Number(process.env.PI_WEB_STALL_NOTIFY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 180_000;
})();
/** Preview panel cap: only the first 512KB of a file is ever read/sent. */

/** Thrown when the service is quiesced (draining) and the request is NEW work
 *  the admission controller refuses: a brand-new client attach, a prompt,
 *  a fork, a session resume, or a goal wizard start. index.ts closes the
 *  WebSocket with 4403 so the browser reconnect loop can retry after the
 *  server reopens admission (see AgentService.quiesce). */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";
	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

// ---------------------------------------------------------------------------
// Preview kind classification. The preview panel only opens image / video /
// text-editable files; everything else (exe, jar, archives, …) is refused so
// it is never read or sent to the browser. Media files are served over the
// /api/file HTTP endpoint instead of the WebSocket, so they are classified
// here but never read into the snapshot path.
// ---------------------------------------------------------------------------

/** 自家内联扩展名（组合模板渲染，见 prompt-composer.ts）。SDK 以其
 *  "<inline:<name>>" 作为 path；扩展白名单/禁用过滤必须放行它。 */
const INLINE_PERSONA_EXT = "<inline:pi-webui-persona>";

/** Pi 包文档路径（composer 的 {{pi_docs}} 自动内容用）。随安装位置解析一次。 */
const PI_DOC_PATHS = (() => {
	try {
		const requireLocal = createRequire(import.meta.url);
		const root = dirname(requireLocal.resolve("@earendil-works/pi-coding-agent/package.json"));
		return { readme: join(root, "README.md"), docs: join(root, "docs"), examples: join(root, "examples") };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
})();

/** Windows persona appendix — appended to the SDK system prompt on win32 only.
 *  Two failure modes it guards against: (1) the SDK bash tool has NO default
 *  timeout, so a long-running command hangs the whole conversation forever;
 *  (2) the in-app terminal is an interactive TTY where heredocs / interactive
 *  programs wait for input that never comes. Legacy Chinese files are often
 *  GBK/GB2312 — read them with the right encoding, never paste mojibake into
 *  reasoning/answers. */
const WINDOWS_PERSONA = `You are a coding agent running on Windows. The bash tool runs Git Bash (bash.exe), not PowerShell. Follow these rules to avoid hanging the session:



- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.
- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.
- In the interactive terminal (TTY) — which is Git Bash too, not PowerShell — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).

Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake (乱码) for them. If a file's content looks garbled, read it through the terminal instead: in Git Bash use \`cat file | iconv -f GBK -t UTF-8\` (or \`iconv -f GBK -t UTF-8 file\`); in cmd use \`chcp 65001 && type file\`; in PowerShell use \`Get-Content -Encoding Default file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`;

/**
 * Killable bash tool: wraps the SDK bash tool (native process spawn, NO terminal).
 * Used when the「默认 bash 覆盖」setting is OFF. Registers its own AbortController
 * into a client-level set (kills) so abortBash() kills only these commands while the
 * agent run and the conversation continue. Exposes persist (ignored — native has no
 * terminal) plus head/tail (post-processed on the returned output) so the parameter
 * schema stays consistent with the terminal-backed tool.
 */
export function makeKillableBashTool(
	cwd: string,
	kills: Set<AbortController>,
	/** per-call 返回文本的服务端语言（默认英文）；工具 definition 走 bilingual 内联双语。 */
	lang: () => ServerLang = () => "en",
): ToolDefinition {
	const base = createLocalBashOperations();
	const tool = createBashTool(cwd, {
		operations: {
			exec: async (command, c, opts) => {
				const ac = new AbortController();
				kills.add(ac);
				try {
					const signals = [opts.signal, ac.signal].filter((s): s is AbortSignal => s !== undefined);
					return await base.exec(command, c, {
						...opts,
						signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
					});
				} finally {
					kills.delete(ac);
				}
			},
		},
	});
	// AgentTool → ToolDefinition (same fields; customTools expects definitions).
	return {
		name: tool.name,
		label: tool.label,
		description:
			"Run a shell command natively (process spawn, no terminal) and return its full output plus exit code — the SDK's plain bash tool. persist is ignored here (no terminal); use head/tail to trim the returned output.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
			persist: Type.Optional(
				Type.Boolean({
					description: "Ignored in native mode (no terminal). Only meaningful when the terminal-backed bash is active.",
				}),
			),
			head: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the FIRST N lines of output (like `| head -N`).",
				}),
			),
			tail: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "Only return the LAST N lines of output (like `| tail -N`).",
				}),
			),
		}),
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const result = (await tool.execute(
				toolCallId,
				params as { command: string; timeout?: number },
				signal,
				onUpdate,
			)) as { content?: Array<{ type: string; text?: string }> };
			// head/tail 后处理（native 无终端，直接截返回行即可）。
			const p = params as { head?: number; tail?: number };
			if ((p?.head || p?.tail) && result?.content?.[0]?.text != null) {
				result.content![0].text = applyHeadTail(result.content![0].text!, p.head, p.tail, lang());
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * 动态分流 bash：按「默认 bash 覆盖」设置（terminalBash）在调用时决定走哪套——
 * 关 = 原生 SDK bash（纯进程、不开终端）；开 = 终端接管 bash（persist 决定一次性/
 * 持久）。开关因此即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）。
 */
export function makeAdaptiveBashTool(
	killable: ToolDefinition,
	terminalBacked: ToolDefinition,
	useTerminal: () => boolean,
): ToolDefinition {
	return {
		...killable,
		description:
			"Run a shell command and return its full output plus exit code. Behavior depends on the「default bash override」setting (terminalBash):\n" +
			"Setting OFF → runs natively (process spawn, no terminal) — the SDK's plain bash tool. persist has no effect.\n" +
			"Setting ON → runs in a visible terminal. persist=true keeps that terminal alive ('ai-bash': shell state such as cd/venv/ssh retained across calls, silent commands move to the background and notify when done); persist=false (default in terminal mode) creates a one-shot terminal that exits when the command finishes while its output stays for review.\n" +
			"Run the bare command — do NOT pipe through head/tail/more/less (use the head/tail parameters to trim the returned output instead; piping also hides live progress in the visible terminal). For interactive commands (REPLs, prompts, installers asking y/n) set persist=true (terminal mode) and drive them with terminal_input / terminal_key.",
		promptSnippet: "run shell commands",
		execute: (id, params, signal, onUpdate, ctx) =>
			(useTerminal() ? terminalBacked : killable).execute(id, params as never, signal, onUpdate, ctx),
	};
}

/**
 * ask_user_question tool: bridges a model question to the browser
 * (question_pending/question_answer, rendered by QuestionDialog) and blocks
 * the agent loop until the user answers or cancels.
 *
 * The SDK has no built-in ask_user_question, so pi-web-ui registers one as a
 * customTool (same mechanism as bash/edit).
 *
 * askUser 签名带 {aborted} 快照而非完整 AbortSignal：customTool 的 execute 信号
 * 服务于整个 agent 生命周期，这里按「已中止即拒绝」的最小语义处理，避免与其它
 * 工具的取消逻辑纠缠。
 */
export function makeAskUserQuestionTool(
	clientSession: {
		askUser: (q: UiQuestion[], sig: { aborted?: boolean }, conversationId?: string) => Promise<QuestionAnswer[] | null>;
	},
	/** 本 runtime 所属会话：提问跟着对话走，快照只把当前对话的问卷推给客户端。 */
	ownerId?: string,
): ToolDefinition {
	const QuestionOptionSchema = Type.Object({
		label: Type.String({ description: "Display label for the option" }),
		description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
		preview: Type.Optional(
			Type.String({
				description:
					"Optional preview rendered below when this option is selected (markdown or HTML — use for mockups/code/config).",
			}),
		),
	});
	const QuestionSchema = Type.Object({
		id: Type.String({ description: "Unique identifier for this question" }),
		question: Type.String({ description: "The full question text to display (markdown/HTML ok)" }),
		detail: Type.Optional(Type.String({ description: "Optional detail/context shown under the question" })),
		header: Type.Optional(Type.String({ description: "Optional short header for this question" })),
		options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Available options to choose from" })),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
	});
	return {
		name: "ask_user_question",
		label: "Ask the user",
		description:
			"Ask the user focused questions to pin down ambiguous requirements. Use for clarifying the task, confirming decisions, or getting preferences. Each question renders a browser dialog with markdown/HTML rich text; options may carry a `preview`. Submit or cancel to resume.",
		promptSnippet:
			"ask the user focused questions to clarify ambiguous requirements (browser dialog with options/preview)",
		promptGuidelines: [
			"When requirements are ambiguous, use ask_user_question to ask the user instead of guessing; prefer multiple-choice options, each option may carry a preview",
			"A cancelled question comes back as a tool error — respect it and continue without re-asking immediately",
		],
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const qs = (params as { questions: UiQuestion[] }).questions;
			if (!Array.isArray(qs) || qs.length === 0) {
				throw new Error("ask_user_question requires at least one question");
			}
			const answers = await clientSession.askUser(
				qs,
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (answers === null) {
				throw new Error("User cancelled the question.\n用户取消了提问。");
			}
			// 工具结果：把每道题的回答拼成简洁文本给模型，同时留 details 供 UI 展示。
			const lines = answers.map((a) => {
				const q = qs.find((q) => q.id === a.id);
				const label = a.selected.join(", ");
				const custom = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
				return `${q?.header ?? q?.id ?? a.id}: ${label || "(no selection)"}${custom}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { answers },
			} as never;
		},
	} as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// Web UI context adapter — bridges extension UI calls (setWidget/notify) to the
// browser. Extensions like rpiv-todo render a TUI widget via
// `ui.setWidget(key, (tui, theme) => comp)`; we capture the component, render it
// with a mock theme to plain text lines, and push them to the client.
// ---------------------------------------------------------------------------

function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => ((c as { type?: string; text?: string })?.type === "text" ? (c as { text: string }).text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

/** PiAstra delegate progress: partial results carry `details.workers`. */
function hasWorkerDetails(partial: unknown): boolean {
	const details = (partial as { details?: { workers?: unknown } } | null | undefined)?.details;
	return Array.isArray(details?.workers);
}

export { workspacePath };
// ---------------------------------------------------------------------------
// Per-client persisted UI state (<dataDir>/client-state.json)
// ---------------------------------------------------------------------------

/**
 * One open conversation (chat thread) of a client. Each conversation owns its
 * OWN AgentSessionRuntime, so starting a new chat or switching between chats
 * never interrupts another conversation's in-flight run.
 */
interface Conversation {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	runtime: AgentSessionRuntime;
	session: AgentSession;
	cwd: string;
	createdAt: number;
	/** In the per-project "running conversations" list. A conversation enters
	 *  the list when it is displaced to the background while still streaming;
	 *  it leaves (and its runtime is freed) when it is opened again and left
	 *  without continuing. */
	listed: boolean;
	/** A prompt was sent while this conversation was active (cleared whenever
	 *  it becomes active). A listed conversation that is displaced while idle
	 *  with this still false counts as "opened but not continued" and is
	 *  dismissed from the list. */
	promptedSinceActive: boolean;
	/** Last time this conversation became active — set_cwd picks the target
	 *  project's most recently active conversation. */
	lastActiveAt: number;
	/** Last time ANY SDK event arrived for this conversation — drives the
	 *  model-stall watchdog (#7): a run that produces no events at all for
	 *  STALL_NOTIFY_MS is probably a half-open API connection. */
	lastSdkEventAt: number;
	/** Set once the stall notice has been sent for the current silent period;
	 *  cleared on every SDK event and on each new prompt. */
	stallNoticed: boolean;
	/** Session event subscription — events are routed to THIS conversation. */
	unsubscribe?: () => void;
	/** Monotonic sequence for message_delta/tool_delta pushes of this conversation —
	 *  a gap on the client triggers a get_state resync. */
	deltaSeq: number;
	/** PTYs belong to the conversation, not the browser socket or client. */
	terminals: TerminalManager;
	// Per-conversation serialization caches (SerializeCache, see
	// session-preview.ts). Message ids derive from (role, timestamp); two
	// conversations can produce identical pairs, so these must never be
	// shared across conversations.
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
	lastMessagesSig: string;
	lastMessagesArray: UiMessage[];
	/** Actual queued prompt TEXTS (steer = 插队, followUp = 排队) — the UI
	 *  renders them as pending bubbles in the real message list. */
	queueSteering: string[];
	queueFollowUp: string[];
	/** Authoritative run lifecycle used for live notification events. */
	notificationLifecycle: NotificationLifecycle;
	/** tool_execution_start timestamps keyed by toolCallId — lets tool_status
	 *  report how long a tool actually ran (vs. waiting on the model). */
	toolStartTimes: Map<string, number>;
	/** LLM 瞬时报错自动重试进行中（agent_end willRetry 占位 → auto_retry_start
	 *  填实 → auto_retry_end 清除）。置位期间快照隐藏末尾的 stopReason=error
	 *  assistant 消息（重试成功则用户永远看不到，耗尽才永久标红），前端改显
	 *  温和的「正在重试」条，而非一闪而过的红色报错。 */
	retryState?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
	/** 上下文压缩进行中（compaction_start 已到、compaction_end 未到）。置位期间
	 *  快照携带 compaction 字段，前端在消息区常驻「压缩中…」进度条（toast 会
	 *  自动消失，而摘要 LLM 调用可能持续数十秒）；结束/失败/取消时清除。 */
	compactionState?: { reason: string; startedAt: number } | null;
	/** 最近一次压缩成功的 estimatedTokensAfter（SDK 自算的压缩后上下文大小）。
	 *  压缩后 SDK getContextUsage() 故意报 null（压缩前的 usage 不可信），
	 *  下轮模型响应前快照用此值回填并标 estimated；开始下一次压缩时清掉。 */
	lastCompactionTokens?: number | null;
	/** tool_call watchdog timers keyed by toolCallId — a tool that runs past
	 *  TOOL_WATCHDOG_TIMEOUT_MS gets the session aborted instead of hanging
	 *  the conversation forever (the SDK bash tool has no default timeout). */
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
}

/** Hard cap on how long ONE tool call may run before the watchdog aborts the
 *  session. The SDK bash tool has NO default timeout, so a command that never
 *  finishes (servers, watchers, infinite loops) would otherwise hang the whole
 *  conversation indefinitely. Override with the PI_WEB_TOOL_TIMEOUT_MS env var
 *  (milliseconds). */
const TOOL_WATCHDOG_TIMEOUT_MS = (() => {
	const v = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 20 * 60_000;
})();

/** Cap on simultaneously open NON-subagent conversations of ONE project (each keeps a full
 *  runtime alive; conversations of other projects keep their own lists).
 *  子代理不计入：子代理是 inMemory 后台任务，不参与此上限，既不占位也不被此上限拦截。 */
const MAX_OPEN_CONVERSATIONS = 8;
/** Coalescing window for worker_transcript pushes: a streaming worker emits
 *  a bridge event per token; followers need a few refreshes a second. */
const WORKER_PUSH_INTERVAL_MS = 200;
const DEFAULT_CONV_TITLE = "新对话";

/** First user text in a session, truncated for the conversation list. */
function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {
		// best-effort — fall through to first-message title
	}
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/** 全局搜索的会话匹配：大小写不敏感，命中任一项即算 ——
 *  显示名、当前项目内的文件名片段、首条消息，以及完整转录文本
 *  （SDK 的 allMessagesText 包含每一段 user 与 assistant 消息，AI 输出也在内）。 */
function sessionMatchesSearch(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	if (s.allMessagesText.toLowerCase().includes(q)) return true;
	return false;
}

/** 抽取一条 AgentMessage 的可搜索文本（user/assistant 的 text 块；
 *  镜像 SDK buildSessionInfo 的 allMessagesText 范围，保证搜索与定位一致）。 */
function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
	}
	return parts.join("\n");
}

/** 扫描一个会话转录文件，收集文本命中查询的消息锚点（role + timestamp，
 *  按转录顺序，最多 cap 个）。仅 user/assistant 消息参与，与搜索范围一致。 */
function collectSessionAnchors(filePath: string, q: string, cap = 10): MessageAnchor[] {
	const anchors: MessageAnchor[] = [];
	if (!q) return anchors;
	try {
		const lines = readFileSync(filePath, "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: {
				type?: unknown;
				message?: { role?: unknown; timestamp?: unknown; content?: unknown };
			};
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e?.type !== "message") continue;
			const m = e.message;
			if (!m) continue;
			if (m.role !== "user" && m.role !== "assistant") continue;
			if (typeof m.timestamp !== "number") continue;
			const text = messageSearchText(m);
			if (!text || !text.toLowerCase().includes(q)) continue;
			anchors.push({ role: m.role, timestamp: m.timestamp });
			if (anchors.length >= cap) break;
		}
	} catch {
		// 单个转录损坏不影响其余会话
	}
	return anchors;
}

/**
 * pi 的会话存储根目录。设置了 `PI_CODING_AGENT_SESSION_DIR` 时，pi 将 transcript
 * 以**扁平布局**直接写在根目录顶层（`<root>/<timestamp>_<uuid>.jsonl`，所属 cwd 是
 * 文件内字段）；未设置时走 SDK 默认的 `<agentDir>/sessions/--<cwd>--/` 每-cwd
 * 子目录布局（此时必须**不传** sessionDir，让 SDK 落回默认路径）。
 *
 * 注意：未设置 env 时**不要**回退返回 `join(getAgentDir(), "sessions")`——那样会把
 * 根目录强塞给 SDK `list()/listAll()`，它们只会扫根目录**顶层** jsonl，默认子目录布局
 * 下顶层为空，历史对话/最近项目会全丢（回归风险，已在 0.84.4 实证）。
 */
export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
}

/** Case-folded key for grouping cwd spellings on case-insensitive filesystems
 *  (`c:\users\me\x` and `C:\Users\me\X` are one directory on Windows, and
 *  one per-cwd session folder). Exact on other platforms. */
function cwdKey(dir: string): string {
	return process.platform === "win32" ? dir.toLowerCase() : dir;
}

/** `.git` directory (or worktree/submodule pointer file) directly under `dir`. */
function isRepoRoot(dir: string): boolean {
	try {
		return existsSync(join(dir, ".git"));
	} catch {
		return false;
	}
}

export class ClientSession {
	readonly clientId: string;
	/** Set by AgentService.attach: reflects the SERVICE-wide quiesce flag
	 *  (server draining — new work rejected). Default false for direct use. */
	isQuiesced: () => boolean = () => false;
	cwd: string;
	/** pi config dir (auth/models/skills). */
	private readonly agentDir: string;
	/** Persisted per-client UI state (last workspace + recent projects). */
	private readonly stateStore: ClientStateStore;
	/** Open conversations — each owns its OWN runtime, so starting a new chat
	 *  or switching chats never interrupts an in-flight run. `runtime` and
	 *  `session` accessors below target the ACTIVE conversation. */
	private convs = new Map<string, Conversation>();
	private activeId = "";
	private convSeq = 0;
	/** One ModelRuntime shared by all conversations — the model chosen in the
	 *  top bar applies to every chat, not just the one that set it. Seeded by
	 *  the first conversation and reused by later ones. */
	private sharedModelRuntime: Awaited<ReturnType<typeof createAgentSessionServices>>["modelRuntime"] | undefined;

	/** Settings-panel state (system prompt + disabled skills/extensions) —
	 *  自包含模块，见 settings-service.ts。resource-loader overrides 在每次
	 *  reload() 时读 current 的最新值，session.reload() 即可应用到运行中 runtime。 */
	private settingsSvc!: SettingsService; // 构造函数里创建（需要 clientId/stateStore）
	/** How long a hard abort waits for session.abort() to make the run idle
	 *  before force-resetting the conversation (model streams that ignore the
	 *  abort signal would otherwise leave the chat stuck forever). */
	private static readonly HARD_ABORT_TIMEOUT_MS = 15_000;
	/** Extra settle window after session.abort() returns: the run is only
	 *  considered stopped once its agent_end event arrives. If it doesn't
	 *  (model stream stuck before the run even started), force-reset. */
	private static readonly HARD_ABORT_SETTLE_MS = 8_000;
	/** Live AbortControllers of THIS client's running bash tool calls — aborting
	 *  them kills only the command (agent run and conversation continue). */
	private bashKills = new Set<AbortController>();
	/** Background-server tracking (port snapshots + 后台任务 panel state) —
	 *  自包含模块，见 bg-servers.ts。列表按 CLIENT 存活，不随对话切换/结束消失。 */
	/** 文件树 / 预览读写 / SCM 查询 / watcher —— 自包含模块，见 files-service.ts。 */
	private readonly files = new FilesService({
		emit: (msg) => this.emit(msg),
		isDisposed: () => this.disposed,
		getCwd: () => this.cwd,
		getActiveCwd: () => this.conv?.cwd ?? this.cwd,
		// issue #91：文件服务错误文案按客户端 UI 语言出中英（英文默认）。
		getLang: () => this.getLang(),
	});
	private readonly bg = new BgServerTracker({
		emit: (msg) => this.emit(msg),
		flushSnapshot: () => this.flushSnapshot(),
		isDisposed: () => this.disposed,
	});
	/** Delegated-worker state per conversation id (PiAstra `delegate` tool),
	 *  fed by the extension's `piastra:workers` event channel through the
	 *  inline pi-webui-workers extension (see makeRuntimeFactory). Keyed
	 *  separately from `convs`: bridge events can arrive before the
	 *  Conversation record exists and the hub must survive runtime swaps. */
	private readonly workerHubs = new Map<string, WorkerHub>();
	/** The extension event bus of each conversation's runtime — lets the
	 *  server send `discover` / `cancel` requests back to the extension. */
	private readonly workerBuses = new Map<string, { emit: (channel: string, data: unknown) => void }>();
	/** Throttle state for worker_transcript pushes, keyed `<convId>:<workerId>`. */
	private readonly workerPushTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** The active conversation (all session operations target it). */
	private get conv(): Conversation {
		const conv = this.convs.get(this.activeId);
		if (!conv) throw new Error("no active conversation");
		return conv;
	}
	/** Runtime of the active conversation. */
	get runtime(): AgentSessionRuntime {
		return this.conv.runtime;
	}
	/** Session of the active conversation. */
	get session(): AgentSession {
		return this.conv.session;
	}

	/** PTYs are owned by individual conversations; this getter targets the active one
	 * for compatibility with the existing terminal-panel dispatch path. */
	get terminals(): TerminalManager {
		return this.conv.terminals;
	}

	getTerminalManager(conversationId?: string): TerminalManager | undefined {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.terminals;
	}

	getTerminalCwd(conversationId?: string): string {
		return (conversationId ? this.convs.get(conversationId) : this.conv)?.cwd ?? this.cwd;
	}

	private makeTerminalManager(conversationId: string, cwd: string): TerminalManager {
		const mgr = new TerminalManager(
			(msg) => this.emitTerminal(conversationId, msg),
			cwd,
			// issue #91：终端输入错误按客户端 UI 语言出中英（英文默认）。
			() => this.getLang(),
		);
		// 终端活力检测：AI 触碰过的终端静默 ≥ 阈值（PI_WEB_TERMINAL_IDLE_MS，
		// 默认 15s）且该对话正在运行时，注入一条 steer 消息唤醒 AI 去检查。
		mgr.onAgentIdle = (terminalId, idleMs, title, lastLines) =>
			this.notifyTerminalIdle(conversationId, terminalId, idleMs, title, lastLines);
		return mgr;
	}

	/** 终端活力提醒：仅在该对话正在流式运行时注入（sendUserMessage 在流式中
	 *  即 steer 语义——当前回合结算后送达，agent 立即响应）；空闲时不打扰。
	 *  一次性语义由 TerminalManager 保证（触发后解除武装，agent 再次触碰才
	 *  重新计时），不会反复刷屏。 */
	private notifyTerminalIdle(
		conversationId: string,
		terminalId: string,
		idleMs: number,
		title: string,
		lastLines = "",
	): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		if (!conv.runtime.session.isStreaming) return;
		const seconds = Math.max(1, Math.round(idleMs / 1000));
		void conv.runtime.session
			.sendUserMessage(
				`（系统自动提醒：你启动的终端「${title}」（id=${terminalId}）已连续 ${seconds} 秒没有任何新输出。` +
					`进程可能在等待输入、卡住或已挂起。\n最近输出：\n${lastLines || "（无输出）"}\n` +
					`请用 terminal_read(terminalId="${terminalId}") 查看/搜索它的当前状态；` +
					`若在等交互就用 terminal_input / terminal_key 回应；确认不再需要就 terminal_close 关掉它。）`,
			)
			.catch(() => {
				// best effort —— 注入失败不影响终端本身
			});
	}

	/**
	 * 终端接管的 bash 静默转后台后的完成通知：命令真正结束时主动告诉 AI。
	 * 流式中 → sendUserMessage（steer，立即唤醒处理）；空闲时 → sendCustomMessage
	 * nextTurn 排队（不唤醒 agent、不耗 token，下次对话自动带上）。
	 */
	private notifyTerminalBashDone(
		terminals: TerminalManager,
		info: { terminalId: string; command: string; exitCode: number | null },
	): void {
		const conv = [...this.convs.values()].find((c) => c.terminals === terminals);
		if (!conv || this.disposed) return;
		let tail = "";
		try {
			const end = terminals.endCursor(info.terminalId);
			if (end !== null) {
				tail = terminals.read(info.terminalId, Math.max(0, end - 4000))?.data ?? "";
			}
		} catch {
			// 终端可能已被关闭
		}
		const exitText = info.exitCode === null ? "终端已关闭" : `退出码 ${info.exitCode}`;
		const cmdShort = info.command.length > 120 ? `${info.command.slice(0, 120)}…` : info.command;
		const text =
			`（系统：你之前在终端 ${info.terminalId} 后台运行的命令已结束（${exitText}）：${cmdShort}\n` +
			`最后输出：\n${stripAnsi(tail).trim() || "（无输出）"}）`;
		const session = conv.runtime.session;
		if (session.isStreaming) {
			void session.sendUserMessage(text).catch(() => {});
		} else {
			// 空闲时不唤醒 agent——排队为 nextTurn 上下文，下次对话自动可见。
			void session
				.sendCustomMessage({
					customType: "terminal-bash-done",
					content: [{ type: "text", text }],
					display: true,
				})
				.catch(() => {});
		}
	}

	private emitTerminal(conversationId: string, msg: ServerMessage): void {
		// Background conversations keep collecting output in their own PTY buffer.
		// Do not stream it into the active xterm; push the retained window on switch.
		if (msg.type === "terminal_output" && conversationId !== this.activeId) return;
		if (msg.type === "terminal_output" || msg.type === "terminal_exit" || msg.type === "terminal_list") {
			this.emit({ ...msg, conversationId } as ServerMessage);
			return;
		}
		this.emit(msg);
	}

	private pushTerminals(conversation = this.conv): void {
		this.emit({
			type: "terminal_list",
			conversationId: conversation.id,
			terminals: conversation.terminals.list(),
		});
		for (const output of conversation.terminals.replay()) {
			this.emit({
				type: "terminal_output",
				conversationId: conversation.id,
				terminalId: output.terminalId,
				data: output.data,
			});
		}
	}

	/**
	 * Vision-bridge transcript cache (batch hash → text). A re-sent / re-asked
	 * prompt with the same images skips the vision API call entirely — editing
	 * a question doesn't re-burn tokens on re-transcribing identical screenshots.
	 */

	/** SYSTEM.md 文件内容（最近一次 loader reload 观察到的 base；组合模板下仅作
	 *  {{soul}} 自动内容，SDK 默认分支不受影响）。非空 = 用户有系统提示词文件。 */
	private lastBaseSystemPrompt = "";

	/** SDK APPEND_SYSTEM.md 内容（appendSystemPromptOverride 收到的 base）——
	 *  composer 的 {{append}} 自动内容。仅主会话（无模板）记录。 */
	private lastSdkAppendFiles: string[] = [];

	/** 当前活动会话的工具/资源快照 → composer 输入。cwd 取活动对话的。 */
	private composeInputs(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
	}): PromptComposerInputs {
		return {
			cwd: src.cwd,
			systemPromptFile: this.lastBaseSystemPrompt || undefined,
			builtinSoul: BUILTIN_SOUL,
			selectedTools: src.selectedTools,
			toolSnippets: src.toolSnippets,
			toolGuidelines: src.toolGuidelines,
			piReadme: PI_DOC_PATHS.readme,
			piDocs: PI_DOC_PATHS.docs,
			piExamples: PI_DOC_PATHS.examples,
			appendFiles: this.lastSdkAppendFiles,
			windowsPersona: process.platform === "win32" ? WINDOWS_PERSONA : "",
			terminalGuidance: isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current))
				? TERMINAL_TOOLS_GUIDANCE
				: "",
			// issue #91：组合模板各来源段按客户端 UI 语言渲染（英文默认）。
			lang: this.getLang(),
			contextFiles: src.contextFiles,
			skills: this.fillSkillContents(src.skills),
			skillsFullText: normalizeSkillList(this.settingsSvc.current.skillsFullText),
		};
	}

	/** skill 全文注入（{{skills}} 全文模式）：最好努力读名单里技能的文件正文。
	 * 单文件 8KB、总量 32KB 封顶，失败/超限/不在名单回落名录（无 content）。
	 * 名单为空时零开销：原样返回，不碰磁盘。 */
	private fillSkillContents(
		skills: { name: string; description: string; filePath: string }[],
	): { name: string; description: string; filePath: string; content?: string }[] {
		const wanted = new Set(normalizeSkillList(this.settingsSvc.current.skillsFullText));
		if (wanted.size === 0) return skills;
		let budget = 32 * 1024;
		return skills.map((s) => {
			if (!wanted.has(s.name) || !s.filePath || budget <= 0) return s;
			try {
				const st = statSync(s.filePath);
				if (!st.isFile() || st.size <= 0 || st.size > 8192) return s;
				const raw = decodeText(readFileSync(s.filePath).subarray(0, Math.min(st.size, budget))).trim();
				budget -= raw.length;
				return raw ? { ...s, content: raw } : s;
			} catch {
				return s;
			}
		});
	}

	/** 渲染当前组合模板。模板为空且无任何覆盖时返回 undefined（用 SDK 默认拼装，
	 *  零开销且与原始行为逐字节一致）。 */
	private renderMainCompose(src: {
		cwd: string;
		selectedTools: string[];
		toolSnippets: Record<string, string>;
		toolGuidelines: string[];
		contextFiles: { path: string; content: string }[];
		skills: { name: string; description: string; filePath: string }[];
	}): string | undefined {
		const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
		const ovs = this.settingsSvc.current.promptOverrides ?? {};
		const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
		if (!tpl && !hasOverride) return undefined;
		const texts = resolveSectionTexts(this.composeInputs(src));
		return renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, ovs);
	}

	/** 从活动会话收集工具/资源快照 → 一次算出 ①各来源默认(自动)内容 ②实际生效的
	 *  完整提示词。会话未就绪（或出错）返回 undefined，调用方给空值。 */
	private sessionPromptSnapshot():
		| {
				texts: Record<string, string>;
				full: string;
				toolsSchema: string;
		  }
		| undefined {
		try {
			const sess = this.session;
			if (!sess) return undefined;
			const cwd = this.conv?.cwd ?? this.cwd;
			const active = sess.getActiveToolNames();
			const snippets: Record<string, string> = {};
			const guidelines: string[] = [];
			const schemaEntries: import("./prompt-composer.js").ToolSchemaEntry[] = [];
			for (const name of active) {
				const def = sess.getToolDefinition(name);
				if (!def) continue;
				if (def.promptSnippet && def.promptSnippet.trim()) snippets[name] = def.promptSnippet;
				if (def.promptGuidelines) guidelines.push(...def.promptGuidelines);
				schemaEntries.push({
					name,
					description: def.description,
					parameters: def.parameters,
				});
			}
			const loader = sess.resourceLoader;
			const texts = resolveSectionTexts(
				this.composeInputs({
					cwd,
					selectedTools: active,
					toolSnippets: snippets,
					toolGuidelines: guidelines,
					contextFiles: loader.getAgentsFiles().agentsFiles,
					skills: loader.getSkills().skills.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						filePath: (s as { filePath?: string }).filePath ?? "",
					})),
				}),
			);
			// 模板/覆盖渲染（无则保持 SDK 默认拼装，与 renderMainCompose 同规则）。
			const tpl = (this.settingsSvc.current.promptTemplate ?? "").trim();
			const ovs = this.settingsSvc.current.promptOverrides ?? {};
			const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
			const rendered =
				!tpl && !hasOverride ? undefined : renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, ovs);
			return { texts, full: rendered ?? sess.systemPrompt, toolsSchema: buildToolsSchemaText(schemaEntries) };
		} catch {
			// Session not ready yet.
			return undefined;
		}
	}

	/** 设置面板预览用的 host 回调（见 SettingsHost.promptSnapshot）：完整生效提示词
	 *  + 各来源默认（自动）内容。会话未就绪时给空值，面板保持可编辑但不预览。 */
	private promptSnapshot(): { full: string; texts: Record<string, string>; toolsSchema: string } {
		return this.sessionPromptSnapshot() ?? { full: "", texts: {}, toolsSchema: "" };
	}

	/** Web-facing extension UI context (widgets, notifications). */
	private webUi = new WebUIContext(
		(msg) => this.emit(msg),
		(conversationId) => this.emitInputRequired(conversationId),
	);
	/** Per-conversation footer statuses (setStatus bridge). Active conversation
	 *  resolved lazily so switches don't have to re-register anything. */
	private readonly convStatuses = new ConversationStatuses(() => this.activeId);
	/** Per-conversation structured todo list (pi-todo bridge). Populated lazily
	 *  by replaying the branch, then kept live from `todo` tool results. */
	private readonly convTodos = new Map<string, ConversationTodos>();

	private widgetsTimer: ReturnType<typeof setInterval> | null = null;
	/** Model-stall watchdog interval (see startStallTimer). */
	private stallTimer: ReturnType<typeof setInterval> | null = null;

	/** Connected sockets for this client (multiple tabs share the session). */
	private sinks = new Set<(msg: ServerMessage) => void>();
	private pendingNotices: ServerMessage[] = [];
	private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timestamp of the most recent message_delta push — while fresh, snapshots
	 *  use the slower STREAMING_SNAPSHOT_INTERVAL_MS cadence. */
	private lastDeltaAt = 0;
	private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
	private version = 0;
	/** Snapshot revision counter (see emitSnapshotNow / protocol snapshot_delta). */
	private snapRev = 0;
	/** Messages array as of the last emitted snapshot/delta — identity-walked
	 *  against the current array to detect append-only growth. */
	private emittedMessages: UiMessage[] | null = null;
	/** Conversation whose messages emittedMessages belongs to. A conversation
	 *  switch (set_cwd / new_chat / switch_*) must fall back to a FULL snapshot:
	 *  two empty conversations have identical (empty) arrays, so the identity
	 *  walk alone would misread the switch as "nothing changed" → delta. */
	private emittedConvId: string | null = null;
	/** snapRev value at which emittedMessages was captured. */
	private emittedRev = 0;
	/** Conversation ids whose runtime switch_session is still booting after a
	 *  transcript-first preview went out (see emitSessionPreview). Non-empty
	 *  → prompts are refused: the client is looking at a conversation that
	 *  does not exist yet, so applying the text to the still-active one would
	 *  send it to the wrong chat. */
	private readonly bootingSwitches = new Set<string>();
	/**
	 * Per-conversation serialization caches (stable message ids, UiMessage
	 * object cache, message-array signature, queue counts) live inside each
	 * Conversation — see Conversation above.
	 */
	private disposed = false;
	/** pi-config readiness check, cached briefly so 60ms snapshots don't hit disk. */
	private piCheckCache: { at: number; configured: boolean } | null = null;

	/** fs.watch on the currently-listed directory — file changes push an instant
	 *  refresh (`file_changed`) so the tree updates without waiting for the 10s
	 *  poll. Only the listed directory is watched (one level); navigating
	 *  re-watches the new target. fs.watch isn't available on every platform /
	 *  filesystem — failures silently fall back to the poll. */
	private fsWatcher: ReturnType<typeof watch> | null = null;
	private watchPath: string | null = null;
	/** fs.watch on the active repo's git dir — external changes (CLI commit,
	 *  IDE branch switch) push `scm_changed` so the panel refreshes itself.
	 *  One watcher per client session, re-targeted when the queried cwd
	 *  changes; failures (bare repo, unsupported fs) silently disable it. */
	private gitWatcher: ReturnType<typeof watch> | null = null;
	private gitWatchCwd: string | null = null;
	private gitDirtyTimer: ReturnType<typeof setTimeout> | null = null;
	private watchTimer: ReturnType<typeof setTimeout> | null = null;

	// -----------------------------------------------------------------------
	// User question bridge (ask_user_question customTool): the model calls the
	// tool → question_pending goes to the browser → wait for question_answer →
	// resolve/reject the tool result (agent loop blocks). One question at a time.
	// -----------------------------------------------------------------------
	private questionSeq = 0;
	/** 待答提问（id → 载荷 + resolve）。一次正常只有一个（agent 阻塞在工具执行）；
	 *  conversationId 记录谁问的：看门狗豁免、快照恢复都靠它。 */
	private pendingQuestions = new Map<
		string,
		{ resolve: (value: QuestionAnswer[] | null) => void; questions: UiQuestion[]; conversationId?: string }
	>();

	private constructor(clientId: string, cwd: string, agentDir: string, stateStore: ClientStateStore) {
		this.clientId = clientId;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.stateStore = stateStore;
		this.settingsSvc = new SettingsService({
			clientId,
			stateStore,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			getSession: () => this.session,
			cwd: () => this.cwd,
			agentDir: () => this.agentDir,
			isStreaming: () => this.session.isStreaming,
			reloadSession: async () => {
				await this.session.reload();
				// reload() 重读磁盘 settings.json，会丢掉内存 applyOverrides
				// （含重试次数覆盖）——依次重放：重试覆盖 → 终端门控。
				this.applyRetryOverrides();
				// reload() 会把 custom 工具重新加回活跃集——重放终端开关。
				this.applyToolGating(this.session);
				await this.pushSlashCommands();
			},
			applyRetryOverrides: () => this.applyRetryOverrides(),
			applyToolGating: () => this.applyToolGating(this.session),
			promptSnapshot: () => this.promptSnapshot(),
		});

		this.modelAdmin = new ModelAdminService({
			agentDir,
			emit: (msg) => this.emit(msg),
			flushSnapshot: () => this.flushSnapshot(),
			isDisposed: () => this.disposed,
			modelRuntime: () => this.runtime.services.modelRuntime,
			invalidatePiConfig: () => {
				this.piCheckCache = null;
			},
			pushModels: async () => this.listModels(),
		});
		// Prune dead background tasks every 30s (only spawns netstat/lsof while
		// the list is non-empty). unref: must not keep the process alive.
		this.bg.start();
	}

	static async create(clientId: string, cwd: string, stateStore: ClientStateStore): Promise<ClientSession> {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();

		const cs = new ClientSession(clientId, cwd, agentDir, stateStore);
		const conversationId = cs.nextConversationId();
		const terminals = cs.makeTerminalManager(conversationId, cwd);
		const runtime = await createAgentSessionRuntime(cs.makeRuntimeFactory(terminals, conversationId), {
			cwd,
			agentDir,
			// Resume the most recent session for this project — the SDK default
			// per-project dir (<agentDir>/sessions/--<cwd>--/, shared with the
			// pi CLI/TUI) — or start a fresh one on first visit.
			sessionManager: SessionManager.continueRecent(cwd),
		});
		// First conversation = the resumed session; it also seeds the shared
		// ModelRuntime that every later conversation reuses.
		cs.sharedModelRuntime = runtime.services.modelRuntime;
		const conv = cs.makeConversation(runtime, conversationId, terminals);
		cs.convs.set(conv.id, conv);
		cs.activeId = conv.id;
		for (const d of runtime.diagnostics) {
			if (d.type !== "info") {
				cs.pendingNotices.push({
					type: "notice",
					level: d.type,
					text: d.message,
				});
			}
		}
		await cs.bindSession();
		await cs.restoreProjectProviderKeysForCwd(cwd);
		await cs.restoreProjectModelForCwd(cwd);
		return cs;
	}

	/**
	 * Factory for cwd-bound runtimes. All conversations share ONE ModelRuntime
	 * (the model choice is client-wide), so later conversations reuse the
	 * instance created with the first one.
	 *
	 */
	private makeRuntimeFactory(terminals: TerminalManager, ownerId?: string): CreateAgentSessionRuntimeFactory {
		return async ({ cwd: effectiveCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: effectiveCwd,
				modelRuntime: this.sharedModelRuntime,
				// 设置面板钩子（官方 SDK 的 resourceLoader overrides）：三个 override
				// 在每次 resourceLoader.reload() 时重放，且读取 this.settings 的当前
				// 值——因此 session.reload() 即可让系统提示词 / 技能 / 插件开关生效，
				// 新对话（新 runtime）也会自动带上当前设置。
				resourceLoaderOptions: {
					// 系统提示词 base：主会话（组合模板）恒返回 undefined → SDK 走默认分支，
					// 工具列表/Guidelines/文档指引等自动段照常拼装；SYSTEM.md 内容仅在
					// 此处捕获（lastBaseSystemPrompt）作 {{soul}} 自动内容。
					systemPromptOverride: (base?: string) => {
						if (typeof base === "string" && base) {
							this.lastBaseSystemPrompt = base;
						}
						return undefined;
					},
					appendSystemPromptOverride: (base: string[]) => {
						// 记录 SDK APPEND_SYSTEM.md base（composer {{append}} 自动内容）。
						this.lastSdkAppendFiles = base.slice();
						const out = [...base];
						// 主会话自定义「追加」已并入组合模板的 {{append}} 覆盖，不再在此注入。
						if (process.platform === "win32") {
							// Windows 专属 persona：bash 工具跑 Git Bash 且无默认超时、终端
							// 是交互式 TTY——注入约束避免 heredoc/交互/长驻命令挂死整个会话；
							// GBK 老中文文件让模型改用终端按正确编码读（iconv/chcp/Get-Content）。
							out.push(WINDOWS_PERSONA);
						}
						if (isTerminalGuidanceOn(effectiveDisabledAgentTools(this.settingsSvc.current))) {
							// 终端工具使用引导（全平台）：告诉模型什么场景该用持久终端
							// 而不是一次性 bash——没有这段模型几乎从不主动选终端工具。
							// 组内工具全关时不注入（不教 AI 用不存在的工具）。
							out.push(TERMINAL_TOOLS_GUIDANCE);
						}
						return out;
					},
					// 技能：按主会话禁用集过滤。
					skillsOverride: (res) => {
						return {
							...res,
							skills: res.skills.filter((s) => !this.settingsSvc.current.disabledSkills.includes(s.name)),
						};
					},
					// 扩展：按主会话禁用集过滤。注意 SDK 在 extensionsOverride 之后才补
					// sourceInfo，包扩展此处只能靠路径匹配 —— isExtensionDisabled 同时比对
					// npm:<pkg> 候选键。
					extensionsOverride: (res) => {
						// 自家内联扩展是基础设施，不参与禁用过滤。
						const keepOwn = (e: { path: string }) => !e.path.startsWith(INLINE_PERSONA_EXT);
						return {
							...res,
							extensions: res.extensions.filter(
								(e) => keepOwn(e) || !isExtensionDisabled(e, this.settingsSvc.current.disabledExtensions),
							),
						};
					},
					// 组合模板渲染：before_agent_start 在每个 agent run 前触发，SDK 此时已用
					// 最新工具/资源拼好基础提示词；若配置了模板或覆盖，则用 composer 把
					// {{token}} 展开为各来源文本（工具列表/项目上下文/技能等都取自本次 run
					// 的 systemPromptOptions，永远最新）。
					extensionFactories: [
						{
							// Worker bridge: subscribe to PiAstra's public worker channel on
							// the runtime's shared extension event bus. Routed by ownerId
							// (conversation id) — a background chat's workers never leak
							// into the active pane.
							name: "pi-webui-workers",
							hidden: true,
							factory: (pi) => {
								if (!ownerId) return;
								this.workerBuses.set(ownerId, pi.events);
								pi.events.on(WORKER_CHANNEL, (event: unknown) => this.onWorkerEvent(ownerId, event));
							},
						},
						{
							name: "pi-webui-persona",
							hidden: true,
							factory: (pi) => {
								pi.on("before_agent_start", (event) => {
									// 组合模板渲染（模板为空且无覆盖时返回 undefined = 用 SDK 默认）。
									const opts = event.systemPromptOptions as
										| {
												cwd?: string;
												selectedTools?: string[];
												toolSnippets?: Record<string, string>;
												promptGuidelines?: string[];
												contextFiles?: { path: string; content: string }[];
												skills?: { name: string; description?: string; filePath?: string }[];
										  }
										| undefined;
									const rendered = this.renderMainCompose({
										cwd: typeof opts?.cwd === "string" ? opts.cwd : this.cwd,
										selectedTools: opts?.selectedTools ?? [],
										toolSnippets: opts?.toolSnippets ?? {},
										toolGuidelines: opts?.promptGuidelines ?? [],
										contextFiles: opts?.contextFiles ?? [],
										skills: (opts?.skills ?? []).map((s) => ({
											name: s.name,
											description: s.description ?? "",
											filePath: s.filePath ?? "",
										})),
									});
									return rendered ? { systemPrompt: rendered } : undefined;
								});
							},
						},
					],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				// 覆盖 SDK 内置 bash（customTools 按 name 覆盖）。双实现分流：
				// 「默认 bash 覆盖」开关（terminalBash）关 → 原生 SDK bash（纯进程、不开终端）；
				// 开 → 终端接管 bash（persist 决定一次性/持久，可静默自动转后台）。
				customTools: [
					makeAdaptiveBashTool(
						// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
						makeKillableBashTool(effectiveCwd, this.bashKills, () => this.getLang()),
						makeTerminalBashTool(terminals, {
							cwd: effectiveCwd,
							// 设置开 = 用终端；此分支里 persist 未显式给时默认一次性（false）。
							defaultPersist: () => false,
							idleMs: () => Math.max(0, Math.floor(this.settingsSvc.current.terminalBashIdleMs) || 0),
							kills: this.bashKills,
							notifyBackgroundDone: (info) => this.notifyTerminalBashDone(terminals, info),
							// issue #91：bash 返回按客户端 UI 语言出中英（英文默认）。
							lang: () => this.getLang(),
						}),
						// 设置关 → 原生 bash；开 → 终端 bash。
						() => this.settingsSvc.current.terminalBash,
					),
					...makePersistentTerminalTools(terminals, effectiveCwd, () => this.getLang()),
					// ask_user_question: model call → questionnaire dialog in the browser.
					makeAskUserQuestionTool(this, ownerId),
				],
			});
			// 终端工具开关从创建起就生效（工具始终注册进注册表，只调活跃集）。
			this.applyToolGating(created.session);
			return {
				...created,
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	/** Allocate a stable conversation id before constructing its runtime/tools. */
	private nextConversationId(): string {
		return `c${++this.convSeq}`;
	}

	/** Wrap a fresh runtime as a new conversation record. `cache` (optional)
	 *  adopts the serialization cache a switch_session preview already built
	 *  over the same transcript, so the real snapshot reuses the preview's
	 *  message ids and object references instead of re-serializing. */
	private makeConversation(
		runtime: AgentSessionRuntime,
		id: string,
		terminals: TerminalManager,
		cache: SerializeCache = newSerializeCache(),
	): Conversation {
		return {
			id,
			title: conversationTitle(runtime.session),
			runtime,
			session: runtime.session,
			cwd: runtime.cwd,
			createdAt: Date.now(),
			// A brand-new conversation is not yet in the running list — it enters
			// only when it is displaced to the background while still streaming.
			listed: false,
			promptedSinceActive: false,
			lastActiveAt: Date.now(),
			lastSdkEventAt: Date.now(),
			stallNoticed: false,
			deltaSeq: 0,
			terminals,
			msgIds: cache.msgIds,
			nextMsgId: cache.nextMsgId,
			userSeqByTs: cache.userSeqByTs,
			uiMessageCache: cache.uiMessageCache,
			lastMessagesSig: "",
			lastMessagesArray: [],
			queueSteering: [],
			queueFollowUp: [],
			notificationLifecycle: new NotificationLifecycle(),
			toolStartTimes: new Map(),
			toolWatchdogs: new Map(),
		};
	}

	// ---- delegated workers (PiAstra) ---------------------------------------

	private workerHub(convId: string): WorkerHub {
		let hub = this.workerHubs.get(convId);
		if (!hub) {
			hub = new WorkerHub(this.agentDir);
			this.workerHubs.set(convId, hub);
		}
		return hub;
	}

	private dropWorkerState(convId: string): void {
		this.workerHubs.delete(convId);
		this.workerBuses.delete(convId);
		for (const key of [...this.workerPushTimers.keys()]) {
			if (key.startsWith(`${convId}:`)) {
				clearTimeout(this.workerPushTimers.get(key));
				this.workerPushTimers.delete(key);
			}
		}
	}

	/** A `piastra:workers` bridge event from the conversation's extension. */
	private onWorkerEvent(convId: string, event: unknown): void {
		if (this.disposed || !isBridgeEvent(event)) return;
		const hub = this.workerHub(convId);
		if (event.type === "workers") {
			if (!hub.applyList(event.workers)) return;
			if (convId === this.activeId) this.scheduleSnapshot();
			// Status flips (finished, cancelled) matter to followers too.
			for (const id of hub.open) this.scheduleWorkerPush(convId, id);
			return;
		}
		if (hub.applyTranscript(event.workerId, event.messages, event.streaming) && hub.open.has(event.workerId)) {
			this.scheduleWorkerPush(convId, event.workerId);
		}
	}

	/** Coalesce transcript pushes per worker (token deltas arrive per event). */
	private scheduleWorkerPush(convId: string, workerId: number): void {
		const key = `${convId}:${workerId}`;
		if (this.workerPushTimers.has(key)) return;
		this.workerPushTimers.set(
			key,
			setTimeout(() => {
				this.workerPushTimers.delete(key);
				void this.pushWorkerTranscript(convId, workerId);
			}, WORKER_PUSH_INTERVAL_MS),
		);
	}

	private async pushWorkerTranscript(convId: string, workerId: number): Promise<void> {
		const hub = this.workerHubs.get(convId);
		if (!hub || !hub.open.has(workerId) || this.disposed) return;
		const transcript = await hub.transcript(workerId);
		if (this.disposed || !hub.open.has(workerId)) return;
		this.emit({ type: "worker_transcript", conversationId: convId, transcript });
	}

	/** Follow one worker of the ACTIVE conversation: reply now, push on change. */
	async openWorker(workerId: number): Promise<void> {
		const convId = this.activeId;
		const hub = this.workerHub(convId);
		if (!hub.has(workerId)) return;
		hub.open.add(workerId);
		// A worker that finished in memory may not have streamed to us yet
		// (opened after the fact): ask the extension for its final messages.
		this.workerBuses.get(convId)?.emit(WORKER_CHANNEL, { version: 1, type: "transcript_request", workerId });
		await this.pushWorkerTranscript(convId, workerId);
	}

	closeWorker(workerId: number): void {
		this.workerHubs.get(this.activeId)?.open.delete(workerId);
	}

	/** Abort ONE running worker (the extension reports it as `cancelled`). */
	cancelWorker(workerId: number): void {
		const hub = this.workerHubs.get(this.activeId);
		if (!hub?.has(workerId)) return;
		this.workerBuses.get(this.activeId)?.emit(WORKER_CHANNEL, { version: 1, type: "cancel", workerId });
	}

	/** Summaries of conversations currently streaming — captured at shutdown
	 *  so the next attach can tell the user their run was interrupted. */
	streamingSummaries(): { title: string; cwd: string }[] {
		const out: { title: string; cwd: string }[] = [];
		for (const conv of this.convs.values()) {
			if (conv.session.isStreaming) out.push({ title: conv.title, cwd: conv.cwd });
		}
		return out;
	}

	/** Tell the user about runs lost to the last server restart (once). */
	notifyInterrupted(list: { title: string; cwd: string; at: number }[] | undefined): void {
		if (!list || list.length === 0) return;
		const names = list.map((r) => `「${r.title}」（${r.cwd}）`).join("、");
		this.pendingNotices.push({
			type: "notice",
			level: "warning",
			text: `${list.length} running conversation(s) were interrupted by the last restart: ${names}. Resume them from History.`,
		});
	}

	/** Add a socket to this client's broadcast set; flushes buffered startup notices. */
	attachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.add(send);
		for (const msg of this.pendingNotices) send(msg);
		this.pendingNotices = [];
		// Replay current extension widgets (setWidget may have fired during
		// session creation, before any socket was attached).
		const widgets = this.webUi.snapshot();
		if (widgets.length > 0) send({ type: "widgets", widgets });
		// Replay the ACTIVE conversation's extension statuses (role footer).
		// Statuses are now per-conversation, so a reconnect must restore the
		// active chat's own role — not whatever a background chat last wrote.
		const statuses = this.activeStatusSnapshot();
		send({ type: "statuses", statuses });
		// Same for the active conversation's structured todo list.
		const active = this.convs.get(this.activeId);
		send({ type: "todos", ...(active ? this.todosFor(active).snapshot() : EMPTY_TODOS) });
		// Reconnect: push the current project's running-conversation list so the
		// left panel shows every background chat (a fresh socket never got the
		// newChat/switch pushes).
		this.emitConversations();
		// Reconnect: same for the slash-command catalog (the picker needs it even
		// before the client asks).
		void this.pushSlashCommands();
		// Reconnect: push the settings panel state (prompt text/mode, skill &
		// extension toggles, saved presets).
		this.pushSettings();
		// Reconnect: push the background-task list — it must survive reconnects
		// and outlive the conversation that started the tasks.
		this.bg.push();
		// Reconnect: push the built-in provider key list (multi-key grouping in the
		// model picker needs it even before the client asks).
		this.modelAdmin.listProviderKeys();
		// PTYs are conversation-owned and survive a socket reconnect.
		this.pushTerminals();
	}

	detachSink(send: (msg: ServerMessage) => void): void {
		this.sinks.delete(send);
		// PTYs intentionally survive a socket drop: they are owned by the
		// conversation and can be inspected after reconnecting. Only conversation
		// disposal or server shutdown kills them.
		if (this.sinks.size === 0) {
			this.files.unwatchDir();
		}
	}

	/** Broadcast to every connected socket of this client. */
	private emit(msg: ServerMessage): void {
		if (this.disposed) return;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const sink of [...this.sinks]) sink(msg);
	}

	private notificationContext(conv: Conversation): {
		conversationId: string;
		projectName: string;
		sessionName?: string;
	} {
		let sessionName: string | undefined;
		try {
			const name = conv.session.sessionManager.getSessionName();
			if (name?.trim()) sessionName = name.trim();
		} catch {
			// Session names are optional metadata; a damaged transcript must not
			// suppress a lifecycle event.
		}
		return {
			conversationId: conv.id,
			projectName: basename(conv.cwd) || conv.cwd,
			sessionName,
		};
	}

	/** A new blocking question/dialog is live-only; it is never replayed. */
	private emitInputRequired(conversationId: string): void {
		const conv = this.convs.get(conversationId);
		if (!conv || this.disposed) return;
		this.emit(makeInputRequiredNotification(this.notificationContext(conv)));
	}

	/** (Re)attach event plumbing to the ACTIVE conversation's session. */
	private async bindSession(skipTodoReplay = false): Promise<void> {
		const conv = this.conv;
		conv.unsubscribe?.();
		conv.session = conv.runtime.session;
		// A replacement runtime may not load the same extensions. Clear stale
		// entries before session_start repopulates its confirmed statuses.
		this.convStatuses.remove(conv.id);
		// The session (and thus the branch) may have been replaced — re-read the
		// todo list from it, keeping the in-flight run's ids. A forced reset has
		// already handed off an ended run and must retain that snapshot instead.
		if (!skipTodoReplay) this.replayTodos(conv, this.todosFor(conv));
		this.pushActiveStatuses();
		await conv.session.bindExtensions({
			mode: "rpc",
			// Per-conversation UI context: setStatus is routed into this
			// conversation's own status map (see uiContextFor), so a background
			// chat's role can't overwrite the active footer.
			uiContext: this.uiContextFor(conv.id),
			onError: (err) => {
				this.emit({ type: "notice", level: "error", text: err.error });
			},
		});
		this.pushActiveStatuses();
		conv.unsubscribe = conv.session.subscribe((event) => this.onEvent(conv, event));
		// A replacement runtime (or a reload) re-registers the extension with an
		// empty worker map; ask it to republish so the pane matches.
		this.workerBuses.get(conv.id)?.emit(WORKER_CHANNEL, { version: 1, type: "discover" });
		// 新会话 / 切换会话 / 强杀重建的必经之路：刚创建的 runtime 用的是 SDK
		// 默认重试 3 次——这里把面板的 retryMaxAttempts 覆盖注入，否则“设了 6
		// 次还是按 3 次重试”。已存在会话重复注入是幂等的（同值覆盖）。
		this.applyRetryOverrides();
		this.scheduleSnapshot();
		this.webUi.refresh();
		this.startWidgetsTimer();
		this.startStallTimer();
	}

	/** Per-conversation extension UI context. Everything delegates to the shared
	 *  webUi (widgets/notifications/dialogs) EXCEPT setStatus, which is routed
	 *  into the given conversation's own status map. This is what keeps a
	 *  background chat's role status from overwriting the active chat's footer. */
	private uiContextFor(convId: string): ExtensionUIContext {
		const base = this.webUi;
		const self = this;
		return new Proxy(base as unknown as Record<string | symbol, unknown>, {
			get(target, prop) {
				if (prop === "setStatus") {
					return (key: string, text: string | undefined): void => self.setConvStatus(convId, key, text);
				}
				// Extension dialogs are shared by the client, but their lifecycle
				// notification must name the conversation that opened them.
				if (prop === "select") {
					return (title: string, options: string[]) => base.openDialogForOwner(convId, "select", title, [options]);
				}
				if (prop === "confirm") {
					return (title: string, message: string) => base.openDialogForOwner(convId, "confirm", title, [message]);
				}
				if (prop === "input") {
					return (title: string, placeholder?: string) =>
						base.openDialogForOwner(convId, "input", title, [placeholder ?? ""]);
				}
				const value = target[prop];
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(base) : value;
			},
		}) as unknown as ExtensionUIContext;
	}

	/** Write a setStatus entry into ONE conversation's own map. When the writer
	 *  is the active conversation, push it to the client immediately; otherwise
	 *  record it and let switchConversation replay it when that chat becomes
	 *  active (a background runtime must never clobber the active footer). */
	private setConvStatus(convId: string, key: string, text: string | undefined): void {
		const clean = text === undefined ? undefined : stripAnsi(text);
		const out = this.convStatuses.set(convId, key, clean);
		if (out) {
			this.emit({ type: "statuses", statuses: out });
		}
	}

	/** Push the ACTIVE conversation's status entries to the client (empty clears
	 *  the footer, which is exactly what a role-less chat needs on switch). */
	private pushActiveStatuses(): void {
		this.emit({ type: "statuses", statuses: this.convStatuses.activeSnapshot() });
		// Same lifecycle: every status replay marks an active-conversation change.
		this.pushActiveTodos();
	}

	/** Todo list of `conv`, replayed from its branch on first access. */
	private todosFor(conv: Conversation): ConversationTodos {
		let t = this.convTodos.get(conv.id);
		if (!t) {
			t = new ConversationTodos();
			this.convTodos.set(conv.id, t);
			this.replayTodos(conv, t);
		}
		return t;
	}

	private replayTodos(conv: Conversation, t: ConversationTodos): void {
		try {
			t.replay(conv.session.sessionManager.getBranch());
		} catch {
			// A runtime without a bound session yet — stays empty until rebind.
		}
	}

	/** Push the ACTIVE conversation's todo list (switch / reconnect / update). */
	private pushActiveTodos(): void {
		const conv = this.convs.get(this.activeId);
		this.emit({ type: "todos", ...(conv ? this.todosFor(conv).snapshot() : EMPTY_TODOS) });
	}

	private pushTodosIfActive(conv: Conversation): void {
		if (conv.id === this.activeId) this.pushActiveTodos();
	}

	/** Status entries of the ACTIVE conversation (for replay on reconnect). */
	private activeStatusSnapshot(): StatusEntry[] {
		return this.convStatuses.activeSnapshot();
	}

	/** Poll extension widgets so TUI-only overlays (e.g. rpiv-todo) stay live. */
	private startWidgetsTimer(): void {
		if (this.widgetsTimer) return;
		this.widgetsTimer = setInterval(() => {
			if (!this.disposed) this.webUi.refresh();
		}, WIDGET_REFRESH_MS);
	}

	/** Model-stall watchdog: warn when a streaming run went completely silent
	 *  (no SDK events at all) for STALL_NOTIFY_MS. Deliberately does NOT abort:
	 *  deep-thinking models can legitimately be quiet for minutes — the notice
	 *  just tells the user the run looks stuck so they can Stop it themselves. */
	private startStallTimer(): void {
		if (this.stallTimer || STALL_NOTIFY_MS === 0) return;
		this.stallTimer = setInterval(() => {
			if (this.disposed) return;
			const now = Date.now();
			for (const conv of this.convs.values()) {
				// 正在等用户回答的对话本就该「无声」——那是人在想，不是失联。
				if (
					!conv.stallNoticed &&
					conv.session.isStreaming &&
					!this.isWaitingOnUser(conv.id) &&
					now - conv.lastSdkEventAt > STALL_NOTIFY_MS
				) {
					conv.stallNoticed = true;
					const mins = Math.round((now - conv.lastSdkEventAt) / 60_000);
					this.emit({
						type: "notice",
						level: "warning",
						text: `Conversation "${conv.title}" has been silent for ${mins} min — possibly disconnected (network or hung server). Stop it and retry.`,
					});
				}
			}
		}, 30_000);
	}

	/** Arm the hang-guard for a tool call: if it is still running after
	 *  TOOL_WATCHDOG_TIMEOUT_MS, abort the session instead of letting the
	 *  conversation hang forever (the SDK bash tool has no default timeout). */
	private armToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = setTimeout(() => {
			conv.toolWatchdogs.delete(toolCallId);
			// The tool finished before the deadline — nothing to do.
			if (!conv.toolStartTimes.has(toolCallId)) return;
			this.emit({
				type: "notice",
				level: "warning",
				text: `Tool ran over ${Math.round(TOOL_WATCHDOG_TIMEOUT_MS / 60_000)} min and was auto-terminated (hang guard). Tune via PI_WEB_TOOL_TIMEOUT_MS (ms).`,
			});
			conv.toolStartTimes.delete(toolCallId);
			// Abort the run (kills the process tree via the SDK's abort signal);
			// agent_end will fire with stopReason "aborted" and existing logic
			// clears any goal / review loop. interruptRun adds a force-reset
			// fallback in case the model stream ignores the abort signal.
			void this.interruptRun(conv, "工具执行超时");
		}, TOOL_WATCHDOG_TIMEOUT_MS);
		t.unref?.();
		conv.toolWatchdogs.set(toolCallId, t);
	}

	/** Cancel a tool's watchdog — called when the tool finishes normally. */
	private clearToolWatchdog(conv: Conversation, toolCallId: string): void {
		const t = conv.toolWatchdogs.get(toolCallId);
		if (t) {
			clearTimeout(t);
			conv.toolWatchdogs.delete(toolCallId);
		}
	}

	/** Cancel every watchdog of a conversation (removeConversation / dispose). */
	private clearAllToolWatchdogs(conv: Conversation): void {
		for (const t of conv.toolWatchdogs.values()) clearTimeout(t);
		conv.toolWatchdogs.clear();
	}

	private onEvent(conv: Conversation, event: AgentSessionEvent): void {
		// Any SDK event proves the run is alive — feeds the stall watchdog below.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		switch (event.type) {
			case "bash_execution_update": {
				if (event.id) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.id,
						toolName: "bash",
						delta: event.delta,
					});
				}
				break;
			}
			case "tool_execution_start": {
				// Record the moment the tool actually starts so tool_status can
				// report real execution time (vs. time spent waiting on the model).
				conv.toolStartTimes.set(event.toolCallId, Date.now());
				// Snapshot listeners before a bash run — the post-run diff catches
				// servers the agent started in the background.
				if (event.toolName === "bash") {
					this.bg.snapshotBefore();
				}
				// 看门狗豁免：ask_user_question 阻塞等的是「人类回答」，不是挂死的工具
				// （默认 20 分钟会把还在思考的用户连对话一起剁掉）。它的收场自有路子：
				// 用户回答/取消、会话 dispose（cancelPendingQuestions），不限时。
				if (event.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
					this.armToolWatchdog(conv, event.toolCallId);
				}
				break;
			}
			case "agent_start": {
				conv.notificationLifecycle.agentStart();
				this.todosFor(conv).startRun();
				this.pushTodosIfActive(conv);
				break;
			}
			case "tool_execution_end": {
				if (event.toolName === TODO_TOOL_NAME) {
					const applied = this.todosFor(conv).apply((event.result as { details?: unknown })?.details);
					if (applied) this.pushTodosIfActive(conv);
				}
				const startedAt = conv.toolStartTimes.get(event.toolCallId);
				conv.toolStartTimes.delete(event.toolCallId);
				this.clearToolWatchdog(conv, event.toolCallId);
				// Bash finished — wait briefly for background servers to bind their
				// ports, then diff against the pre-run snapshot and record them.
				if (event.toolName === "bash") void this.bg.trackAfterBash();
				const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
				// The bash tool does not put its exit code in result.details — on
				// failure it throws "Command exited with code N" and the agent
				// wraps that into the error result text. Try details first (future
				// tools / SDK changes), then parse the error text.
				const details = (event.result as { details?: unknown })?.details;
				let exitCode: number | undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					typeof (details as { exitCode?: unknown }).exitCode === "number"
				) {
					exitCode = (details as { exitCode: number }).exitCode;
				} else if (event.isError) {
					const content = (event.result as { content?: unknown })?.content;
					const text = Array.isArray(content)
						? content
								.map((c) =>
									typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text"
										? ((c as { text?: unknown }).text ?? "")
										: "",
								)
								.join("\n")
						: "";
					const m = text.match(/exited with code (\d+)/);
					if (m) exitCode = Number(m[1]);
				}
				this.emit({
					type: "tool_status",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.isError,
					exitCode,
					durationMs,
				});
				break;
			}
			case "tool_execution_update": {
				// PiAstra delegate progress travels structured over the worker
				// bridge (UiState.workers); its text form is a whole-status
				// snapshot per tick, not a delta, and would pile up in the card.
				if (hasWorkerDetails(event.partialResult)) break;
				const text = extractPartialText(event.partialResult);
				if (text) {
					this.emit({
						type: "tool_delta",
						conversationId: conv.id,
						seq: ++conv.deltaSeq,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						delta: text,
					});
				}
				break;
			}
			case "queue_update":
				conv.queueSteering = [...event.steering];
				conv.queueFollowUp = [...event.followUp];
				break;
			// 手动 /compact 或阈值/溢出自动压缩开始——常驻进度条（快照 compaction
			// 字段），而不是一次性 toast（toast 几秒就消失，而摘要生成可能持续
			// 数十秒，用户会以为「没反应」）。立即 flush 让进度条第一时间出现。
			case "compaction_start": {
				conv.compactionState = { reason: event.reason, startedAt: Date.now() };
				conv.lastCompactionTokens = null;
				this.flushSnapshot();
				break;
			}
			case "compaction_end": {
				conv.compactionState = null;
				if (event.errorMessage) {
					this.emit({
						type: "notice",
						level: "error",
						text: `Context compaction failed: ${event.errorMessage}`,
					});
				} else if (event.aborted) {
					this.emit({
						type: "notice",
						level: "warning",
						text: "Context compaction cancelled",
					});
				} else if (event.result) {
					const { tokensBefore, estimatedTokensAfter } = event.result;
					const after = estimatedTokensAfter ?? tokensBefore;
					// 记住压缩后大小：SDK 在下轮响应前报 null，快照用此回填底栏。
					conv.lastCompactionTokens = estimatedTokensAfter ?? null;
					this.emit({
						type: "notice",
						level: "info",
						text: `Context compacted: ${tokensBefore.toLocaleString()} → ${after.toLocaleString()} tokens (summary inserted into the message list)`,
					});
				}
				break;
			}
			case "auto_retry_start": {
				// 大模型 API 瞬时报错，SDK 退避重试：填实重试信息。末尾 error
				// 消息已被（或即将被）SDK 从 state 摘掉，currentMessages() 凭此旗
				// 过滤，快照只显示温和的重试条。落盘由底部检查点立即 flush。
				conv.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
				break;
			}
			case "auto_retry_end": {
				// 重试结束：成功 → 新内容照常显示；耗尽 → error 消息留驻，
				// 快照永久标红。落盘由底部检查点立即 flush。
				conv.retryState = null;
				break;
			}
			// A run finished or a new entry was persisted — keep the session list fresh
			// (new chat + first message, completed turns, compaction, etc.).
			case "agent_end": {
				conv.notificationLifecycle.agentEnd(event.messages);
				this.todosFor(conv).endRun();
				this.pushTodosIfActive(conv);
				// 可重试错误：SDK 随后发 auto_retry_start 并把末尾 error 消息从
				// state 摘掉。这里先立占位，让本次立即 flush 的快照就不含瞬时红错
				// ——否则快照先画红、摘掉后又消失，即「红色报错一闪而过」。
				if (event.willRetry) {
					let errorMessage = "";
					for (let i = event.messages.length - 1; i >= 0; i--) {
						const m = event.messages[i] as { role?: unknown; errorMessage?: unknown };
						if (m.role === "assistant" && typeof m.errorMessage === "string") {
							errorMessage = m.errorMessage;
							break;
						}
					}
					conv.retryState = { attempt: 0, maxAttempts: 0, delayMs: 0, errorMessage };
				} else {
					// 本轮结束且无后续重试：任何残留占位都是过期的（会话替换、
					// 结束信号丢失等），清掉，否则横幅会卡住不消失。
					conv.retryState = null;
				}
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				// Manual interrupt (Stop button / abort): the last assistant message
				// carries stopReason "aborted" — nothing to apply, let the user give a
				// fresh instruction.
				const aborted = (event.messages as unknown[]).some((m) => {
					const a = m as { role?: string; stopReason?: string };
					return a.role === "assistant" && a.stopReason === "aborted";
				});
				if (aborted) break;
				// Deferred settings reload: settings (system prompt / skills /
				// extensions) changed while the run was streaming — applying now
				// would have torn down the in-flight run.
				if (this.settingsSvc.hasPendingReload() && !this.disposed) {
					this.settingsSvc.consumePendingReload();
					void this.applySettingsReload();
				}
				break;
			}
			case "agent_settled": {
				let retrying = !!conv.retryState;
				try {
					retrying ||= conv.session.retryAttempt > 0;
				} catch {
					// Older SDKs do not expose retryAttempt; retryState remains the
					// defensive fallback.
				}
				const notification = conv.notificationLifecycle.settled({
					...this.notificationContext(conv),
					isIdle: conv.session.isIdle,
					queuedSteering: conv.queueSteering,
					queuedFollowUp: conv.queueFollowUp,
					retrying,
					workers: this.workerHub(conv.id).list(),
				});
				if (notification) this.emit(notification);
				break;
			}
			case "entry_appended": {
				// SDK 仅在扩展 appendEntry 时发 entry_appended（entry 恒为 custom），
				// assistant 消息不会走这里——气泡级解析见 case "message_end"。
				this.scheduleSessionsRefresh();
				this.refreshConversationTitle(conv);
				break;
			}
			case "message_end": {
				const mm = event.message as { role?: string; stopReason?: unknown };
				if (mm?.role !== "assistant") break;
				// A non-error assistant message ends the retry cycle (same condition
				// the SDK uses to reset _retryAttempt) — the banner never gets stuck
				// even if auto_retry_end is lost.
				if (mm.stopReason !== "error") conv.retryState = null;
				break;
			}
			case "message_update": {
				// Live assistant-message increment, deliberately OUTSIDE the snapshot
				// channel: send() drops snapshots under backpressure (big sessions),
				// but this small message must always get through or the UI freezes on
				// stale state. Only the ACTIVE conversation streams to the browser —
				// background conversations would clobber the streaming view; their
				// state arrives via snapshot when switched to.
				if (conv.id !== this.conv.id) break;
				const ame = event.assistantMessageEvent;
				const m = event.message as { timestamp?: number };
				this.lastDeltaAt = Date.now();
				this.emit({
					type: "message_delta",
					conversationId: conv.id,
					seq: ++conv.deltaSeq,
					// Must match serializeStreamingMessage()'s stable id so deltas
					// patch onto the snapshot's streamingMessage and reconcile.
					messageId: `stream-${m?.timestamp ?? 0}`,
					usage: (() => {
						try {
							const t = this.session.getSessionStats().tokens;
							return t ? { input: t.input, output: t.output, total: t.total } : null;
						} catch {
							return null;
						}
					})(),
					// Strip `partial` (the cumulative message): re-serializing it per
					// token is exactly what we're trying to avoid. The next snapshot
					// carries the authoritative full message anyway.
					assistantMessageEvent: {
						type: ame.type,
						contentIndex: "contentIndex" in ame ? ame.contentIndex : undefined,
						delta: "delta" in ame ? ame.delta : undefined,
					},
				});
				break;
			}
			default:
				break;
		}
		// Snapshot checkpoint policy: deltas carry live rendering during streaming;
		// full snapshots are reconciliation checkpoints taken immediately at
		// run/tool boundaries and on a slow timer otherwise.
		if (
			event.type === "agent_end" ||
			event.type === "tool_execution_end" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.flushSnapshot();
		} else {
			this.scheduleSnapshot();
		}
	}

	/** Debounced push of the persisted session list + open conversations. */
	private scheduleSessionsRefresh(): void {
		if (this.sessionsTimer) return;
		this.sessionsTimer = setTimeout(() => {
			this.sessionsTimer = null;
			if (this.disposed) return;
			this.emitConversations();
			void this.pushSessions();
		}, 800);
		// pushSessions no-ops unless the client opted in via list_sessions.
	}

	/** Refresh a conversation's title from its persisted first user message
	 *  while it is still unnamed. Runs off the event stream (entry_appended /
	 *  agent_end) rather than the prompt() call site, so ANY entry path that
	 *  lands a message names the chat the moment it is persisted — a rename
	 *  skipped by the prompt-start fast path (e.g. a concurrent switch) is
	 *  recovered here instead of leaving a permanent “新对话”. */
	private refreshConversationTitle(conv: Conversation): void {
		if (conv.title !== DEFAULT_CONV_TITLE) return;
		const title = conversationTitle(conv.session);
		if (title === DEFAULT_CONV_TITLE) return;
		conv.title = title;
		this.emitConversations();
	}

	/** Serialize a persisted message with a STABLE id + cached object reference. */
	private serializeCached(m: AgentMessage): UiMessage | null {
		return this.serializeCachedFor(this.conv, m);
	}

	/** serializeCached 的按对话版本（插件快照读非活跃对话用；缓存仍按对话隔离）。
	 *  The cache logic itself lives in session-preview.ts so the switch_session
	 *  preview can run it over a bare transcript. */
	private serializeCachedFor(conv: Conversation, m: AgentMessage): UiMessage | null {
		return serializeCachedInto(conv, m);
	}

	/** Current messages array (with the existing sig-reuse optimization).
	 *  Element objects are reference-stable (serializeCached cache), which is
	 *  what lets emitSnapshotNow detect append-only growth via identity walk. */
	private currentMessages(): UiMessage[] {
		return this.messagesOf(this.conv);
	}

	/** currentMessages 的按对话版本（插件快照读非活跃对话用）。 */
	private messagesOf(conv: Conversation): UiMessage[] {
		let rawMessages = conv.session.agent.state.messages
			.map((m) => this.serializeCachedFor(conv, m))
			.filter((m): m is NonNullable<typeof m> => m !== null);
		// 自动重试等待期：SDK 暂留在 state 末尾的 error 气泡只是中间态（随后被
		// 摘掉重跑），不进快照——成功则用户永远看不到，耗尽才标红。否则 agent_end
		// 的立即 flush 会先画红、摘掉后又消失（红色一闪而过）。
		rawMessages = stripTransientRetryErrors(rawMessages, !!conv.retryState);
		// Reuse the previous array when nothing changed: the element objects are
		// cached (reference-stable) anyway, and a stable array reference lets the
		// frontend memoize derived maps instead of rebuilding them every 60ms.
		const sig = rawMessages.map((m) => m.id).join("\u0001");
		const messages = conv.lastMessagesSig === sig ? conv.lastMessagesArray : rawMessages;
		conv.lastMessagesSig = sig;
		conv.lastMessagesArray = rawMessages;
		return messages;
	}

	/** Build every UiState field EXCEPT messages (the expensive part). */
	private buildLightState(rev: number): Omit<UiState, "messages" | "rev"> & { rev: number } {
		const conv = this.conv;
		const state = conv.session.agent.state;
		const model = state.model;
		let stats: UiState["stats"] = {
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		};
		try {
			const s = this.session.getSessionStats();
			stats = {
				totalMessages: s.totalMessages,
				tokens: s.tokens,
				cost: s.cost,
				contextUsage: (() => {
					const cu = s.contextUsage;
					if (!cu) return stats.contextUsage;
					// 压缩刚结束、下轮响应未到：SDK 报 null，用压缩结果回填约数。
					if (cu.tokens == null && conv.lastCompactionTokens != null && cu.contextWindow > 0) {
						return {
							tokens: conv.lastCompactionTokens,
							contextWindow: cu.contextWindow,
							percent: (conv.lastCompactionTokens / cu.contextWindow) * 100,
							estimated: true,
						};
					}
					return {
						tokens: cu.tokens,
						contextWindow: cu.contextWindow,
						percent: cu.percent,
					};
				})(),
			};
		} catch {
			// stats are best-effort
		}
		// 流式 error 同样是中间态（定稿走 message_end/agent_end）：先藏起
		// errorMessage，避免红色在 streaming 气泡里闪一下。最终失败会经由
		// messages 永久标红，不影响告警。
		let streamingMessage = state.streamingMessage ? serializeStreamingMessage(state.streamingMessage) : null;
		if (streamingMessage?.stopReason === "error") {
			streamingMessage = { ...streamingMessage, errorMessage: undefined };
		}
		return {
			clientId: this.clientId,
			cwd: this.cwd,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			conversationId: this.activeId,
			rev,
			streamingMessage,
			isStreaming: this.session.isStreaming,
			model: model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						vision: model.input?.includes("image") ?? false,
					}
				: null,
			thinkingLevel: state.thinkingLevel,
			// Only the levels the current model actually supports — the SDK clamps
			// anything else, so the UI must not offer (or must disable) the rest.
			availableThinkingLevels: this.session.getAvailableThinkingLevels(),
			queue: { steering: conv.queueSteering, followUp: conv.queueFollowUp },
			errorMessage: state.errorMessage,
			retry: conv.retryState ?? null,
			compaction: conv.compactionState ?? null,
			pendingQuestion: this.pendingQuestionForSnapshot(),
			workers: this.workerHub(conv.id).list(),
			tools: state.tools.map((t) => t.name),
			version: ++this.version,
			piConfigured: this.isPiConfigured(),
			piAgentInstalled: this.isPiCliInstalled(),
			stats,
		};
	}

	/** Emit one snapshot update — incremental when possible, full otherwise.
	 *
	 *  Persisted messages are content-immutable with reference-stable objects
	 *  (serializeCached), so an IDENTITY WALK over the previous array detects
	 *  append-only growth in O(n) pointer compares. Appends travel as
	 *  snapshot_delta carrying only the new tail + light fields; any mid-array
	 *  change/truncation (switch session, edit fork, compaction) or a forced
	 *  resync falls back to a full snapshot. The 10MB-stringify-per-checkpoint
	 *  cost of big sessions collapses to a few hundred bytes for the common
	 *  "nothing but stats/version changed" checkpoint. */
	private emitSnapshotNow(forceFull = false): void {
		if (this.disposed) return;
		const cur = this.currentMessages();
		const prev = this.emittedMessages;
		let incremental = !forceFull && prev !== null && this.emittedConvId === this.activeId && prev.length <= cur.length;
		if (incremental && prev) {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i] !== cur[i]) {
					incremental = false;
					break;
				}
			}
		}
		const rev = ++this.snapRev;
		if (incremental && prev) {
			const baseRev = this.emittedRev;
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot_delta",
				conversationId: this.activeId,
				rev,
				baseRev,
				appended: cur.slice(prev.length),
				state: this.buildLightState(rev),
			});
		} else {
			this.emittedMessages = cur;
			this.emittedConvId = this.activeId;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				state: { ...this.buildLightState(rev), messages: cur },
			});
		}
	}

	/** Resolve a browser-bridged dialog (select/confirm/input) for this session. */
	resolveDialog(id: number, value: string | boolean | null): void {
		this.webUi.resolveDialog(id, value);
	}

	// -----------------------------------------------------------------------
	// 用户提问桥（标准 pi 引擎 ask_user_question customTool）
	// -----------------------------------------------------------------------

	/** 标准引擎模型调 ask_user_question：发 question_pending 给浏览器并阻塞等待
	 *  question_answer。sig 为工具执行信号的当前状态（aborted → 立即 reject）。
	 *  返回 answers（用户选中/自定义），或 null（用户取消）。
	 *
	 *  不设超时：等的是「人类回答」，不是挂死的工具。因此也不进工具挂死看门狗
	 *  （见 tool_execution_start）、不算 stall 失联（见 startStallTimer）。 */
	askUser(
		questions: UiQuestion[],
		sig: { aborted?: boolean },
		conversationId?: string,
	): Promise<QuestionAnswer[] | null> {
		return new Promise((resolve, reject) => {
			if (sig?.aborted || this.disposed) {
				reject(new Error("ask_user_question 已中止"));
				return;
			}
			// 问卷开关（默认开）：关 → 不弹对话框，立即报错让模型得知已禁用。
			// 与统一工具门控双保险：工具 tab 里单独关掉 ask_user_question 也一样拒收。
			if (
				this.settingsSvc.current.questionnaireEnabled === false ||
				(this.settingsSvc.current.disabledAgentTools ?? []).includes(ASK_USER_QUESTION_TOOL_NAME)
			) {
				reject(new Error("问卷功能已关闭，可在设置中重新开启"));
				return;
			}
			const id = `q-${++this.questionSeq}`;
			this.pendingQuestions.set(id, { resolve, questions, conversationId });
			if (conversationId) this.emitInputRequired(conversationId);
			this.emit({
				type: "question_pending",
				id,
				questions,
			});
		});
	}

	/** 前端回答模型提问（question_answer → 恢复 askUser 的 Promise）。id 需匹配
	 *  pendingQuestions 中键；cancelled 或未匹配（例如用户早已切走）时按「取消」处理
	 *  —— 把挂起的提问全部 reject，让模型知道用户离开了。 */
	resolveQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): void {
		const pending = this.pendingQuestions.get(id);
		if (pending) {
			this.pendingQuestions.delete(id);
			pending.resolve(cancelled ? null : answers);
		}
	}

	/** 快照侧的待答提问（UiState.pendingQuestion）：只带当前对话的问卷——切回
	 *  原对话会重推快照，对话框随之回来（重连/刷新/第二标签页的恢复通道）。 */
	private pendingQuestionForSnapshot(): UiState["pendingQuestion"] {
		for (const [id, p] of this.pendingQuestions) {
			if (p.conversationId !== undefined && p.conversationId !== this.activeId) continue;
			return { id, questions: p.questions };
		}
		return null;
	}

	/** 对话是否阻塞在等用户回答上（用于 stall 失联判定豁免）。 */
	private isWaitingOnUser(conversationId: string): boolean {
		for (const p of this.pendingQuestions.values()) {
			if (p.conversationId === undefined || p.conversationId === conversationId) return true;
		}
		return false;
	}

	/** 标准引擎的 question_answer 路由入口（index.ts 经 cs.answerQuestion?. 转发）。
	 *  DSH 引擎的 AgentService 也实现了同名方法，此处为 ClientSession 的转发。 */
	answerQuestion(id: string, answers: QuestionAnswer[], cancelled?: boolean): Promise<void> {
		this.resolveQuestion(id, answers, cancelled);
		return Promise.resolve();
	}

	/** 关闭所有挂起提问（dispose 时清理）：以「取消」解析，避免模型挂死。 */
	cancelPendingQuestions(): void {
		for (const [, p] of this.pendingQuestions) {
			p.resolve(null);
		}
		this.pendingQuestions.clear();
	}

	/**
	 * Whether the pi agent has at least one usable model. ModelRuntime's
	 * available snapshot already accounts for models.json, auth.json, env-var
	 * credentials, OAuth, and runtime API-key overrides. Cached for 2s because
	 * this is called while building frequent snapshots.
	 */
	isPiConfigured(): boolean {
		const now = Date.now();
		const cached = this.piCheckCache;
		if (cached && now - cached.at < 2000) return cached.configured;
		const configured = (this.sharedModelRuntime?.getAvailableSnapshot().length ?? 0) > 0;
		this.piCheckCache = { at: now, configured };
		return configured;
	}

	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). Cached machine-wide (same binary for every client) for 10s —
	 * the check is only rerun after install or when the cache expires.
	 *
	 * The probe is FORK-FREE: it scans PATH for the pi executable instead of
	 * spawning `pi --version`. Do not reintroduce a spawn here — ANY fork on
	 * the main thread of this multi-threaded server can deadlock the whole
	 * process on Android/Termux (issue #78): libuv's uv_spawn blocks its
	 * caller reading the child's error pipe, and that pipe never closes when
	 * the forked child deadlocks between fork and exec. This applies to
	 * asynchronous spawns too — the previous async probe reproduced the hang.
	 */
	private static piCliProbe: { at: number; installed: boolean } | null = null;
	private static readonly PI_CLI_PROBE_TTL_MS = 10_000;

	private isPiCliInstalled(): boolean {
		const now = Date.now();
		const cached = ClientSession.piCliProbe;
		if (cached && now - cached.at < ClientSession.PI_CLI_PROBE_TTL_MS) return cached.installed;
		const installed = ClientSession.piCliOnPath();
		ClientSession.piCliProbe = { at: now, installed };
		return installed;
	}

	private static piCliOnPath(): boolean {
		const dirs = (process.env.PATH ?? "").split(delimiter);
		for (const dir of dirs) {
			if (dir && existsSync(join(dir, "pi"))) return true;
		}
		return false;
	}

	private static invalidatePiCliProbe(): void {
		ClientSession.piCliProbe = null;
	}

	/**
	 * Run a command async, collecting stdout+stderr; kills on timeout.
	 * Never throws / never crashes the server: spawn errors (ENOENT etc.)
	 * resolve with code -1 so callers can report them as notices.
	 */
	private runAsync(
		cmd: string,
		args: string[],
		timeoutMs: number,
		cwd?: string,
	): Promise<{ code: number | null; out: string }> {
		return new Promise((resolve) => {
			let p;
			try {
				p = spawn(cmd, args, {
					...(cwd ? { cwd } : {}),
					stdio: ["ignore", "pipe", "pipe"],
					// Windows: npm and friends are .cmd shims — Node can only exec
					// them through the shell (otherwise spawn npm → ENOENT).
					shell: process.platform === "win32",
				});
			} catch (err) {
				resolve({ code: -1, out: String(err) });
				return;
			}
			let out = "";
			let settled = false;
			const done = (code: number | null, text?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(t);
				resolve({ code, out: text ?? out });
			};
			const t = setTimeout(() => p.kill(), timeoutMs);
			p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			p.stderr?.on("data", (d: Buffer) => (out += d.toString()));
			p.on("error", (err) => done(-1, String(err)));
			p.on("close", (code) => done(code));
		});
	}

	/**
	 * Auto-install the pi agent: ensure the config dir exists and install the
	 * pi CLI globally (npm i -g). Auth is configured afterwards via the API key
	 * form or by running `pi` in a terminal.
	 */

	/**
	 * Version of the RUNNING pi-web-ui package (read from its own package.json,
	 * resolved from this compiled module: <pkg>/dist/server → <pkg>).
	 */
	private static currentAppVersion(): string {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const pkgRoot = resolve(here, "..", "..");
			const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
			return pkg.version ?? "0.0.0";
		} catch {
			return "0.0.0";
		}
	}

	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 本客户端成功切换工作区（set_cwd）后触发，参数为新绝对路径。
	 *  attach 时由 AgentService 接到全局 onClientCwdChanged —— 编辑器等
	 *  工作区跟随型插件借此把根目录切到用户当前项目。 */
	onCwdChanged: ((abs: string) => void) | undefined = undefined;

	async installPiAgent(): Promise<void> {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			this.emit({
				type: "notice",
				level: "info",
				text: "Installing pi agent CLI (npm i -g @earendil-works/pi-coding-agent)…",
			});
			const { code, out } = await this.runAsync("npm", ["i", "-g", "@earendil-works/pi-coding-agent"], 180_000);
			if (code === 0) {
				this.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				this.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				this.emit({
					type: "notice",
					level: "error",
					text: `pi agent install failed (${code ?? "timeout"}): ${out.slice(0, 400)}`,
				});
				this.emit({
					type: "install_result",
					ok: false,
					detail: out.slice(0, 600),
				});
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `pi agent install failed: ${(err as Error).message}`,
			});
		}
		// The CLI may just have landed on PATH (or the install may have failed) —
		// drop the probe cache so the next snapshot re-checks.
		ClientSession.invalidatePiCliProbe();
		this.flushSnapshot();
	}

	/** Send a snapshot immediately (cancels any pending throttled one).
	 *  forceFull skips the incremental path — used by get_state so a (re)
	 *  connecting or desynced client always receives an authoritative full
	 *  state it can rebuild from. */
	flushSnapshot(forceFull = false): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		this.emitSnapshotNow(forceFull);
	}

	private scheduleSnapshot(): void {
		if (this.snapshotTimer || this.disposed) return;
		// During active streaming the deltas carry live rendering — full snapshots
		// are just a periodic reconciliation checkpoint, so send them far less
		// often (they serialize the whole session; big sessions made this path OOM).
		const interval =
			Date.now() - this.lastDeltaAt < DELTA_ACTIVE_WINDOW_MS ? STREAMING_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = null;
			this.emitSnapshotNow();
		}, interval);
	}

	/** Slash-command catalog + native command execution — 自包含模块，见
	 *  slash-commands.ts（内置命令拦截 + 扩展/模板/技能目录推送）。 */
	private readonly slash = new SlashCommandsService({
		emit: (msg) => this.emit(msg),
		cwd: () => this.cwd,
		getSession: () => this.session,
		newChat: () => this.newChat(),
		// /new <prompt>: deliver the text as the new session's first prompt.
		prompt: (text) => this.prompt(text),
		setModel: (id) => this.setModel(id),
		setCwd: (path) => this.setCwd(path),
		setThinking: (level) => this.setThinking(level),
		renameSession: async (name) => {
			this.session.setSessionName(name);
			this.conv.title = name;
			this.invalidateSessionInfos();
			this.emitConversations();
			await this.pushSessions();
			this.emit({
				type: "notice",
				level: "info",
				text: `Renamed current session to "${name}"`,
			});
			this.flushSnapshot();
		},
		refreshSessions: () => this.refreshSessions(),
		afterReload: () => {
			// /reload 同样重读磁盘 settings.json——重放重试覆盖 + 终端门控。
			this.applyRetryOverrides();
			this.applyToolGating(this.session);
		},
		onQuit: () => this.onQuit?.() ?? false,
	});

	/** Catalog push — index.ts get_commands / attach / cwd 切换等都会调用。 */
	pushSlashCommands(): Promise<void> {
		return this.slash.push();
	}

	/** 模型/服务商配置管理 —— 自包含模块，见 model-admin.ts。 */
	private readonly modelAdmin!: ModelAdminService;

	/** Account-level quotas use the same native auth/runtime as this client's chats. */
	getSubscriptions(providerId?: string) {
		return providerId
			? subscriptionUsage.refresh(this.sharedModelRuntime!, providerId)
			: subscriptionUsage.read(this.sharedModelRuntime!);
	}

	/** Persist an api-key credential for a provider (auth.json). */
	setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		return this.modelAdmin.setProviderApiKey(provider, apiKey);
	}
	async clearProviderApiKey(provider: string): Promise<void> {
		await this.modelAdmin.clearProviderApiKey(provider);
		// The provider is back to unconfigured — drop its key preference in
		// EVERY project, otherwise each project switch re-tries a restore.
		this.stateStore.deleteProviderEverywhere(provider.trim());
	}
	listProviders(): Promise<void> {
		return this.modelAdmin.listProviders();
	}
	listModelsConfig(): Promise<void> {
		return this.modelAdmin.listModelsConfig();
	}
	reloadModelsConfig(): Promise<void> {
		return this.modelAdmin.reloadModelsConfig();
	}
	fetchModelsList(reqId: number, baseUrl: string, apiKey?: string, authHeader?: boolean, api?: string): Promise<void> {
		return this.modelAdmin.fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, () => this.getLang());
	}
	refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.refreshProviderModels(providerId, reqId, () => this.getLang());
	}
	/** Copy a built-in provider into an editable custom-provider draft
	 *  (clone_provider_result) — lets the user run a second API key without
	 *  overwriting the built-in one. */
	cloneProvider(providerId: string, reqId: number): Promise<void> {
		return this.modelAdmin.cloneProvider(providerId, reqId);
	}
	saveModelConfig(providerId: string, config: unknown): Promise<void> {
		return this.modelAdmin.saveModelConfig(providerId, config as never);
	}
	deleteModelConfig(providerId: string): Promise<void> {
		return this.modelAdmin.deleteModelConfig(providerId);
	}
	listProviderKeys(): void {
		return this.modelAdmin.listProviderKeys();
	}
	async addProviderKey(provider: string, apiKey: string, name?: string): Promise<void> {
		await this.modelAdmin.addProviderKey(provider, apiKey, name);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, active);
	}
	async activateProviderKey(provider: string, keyName: string): Promise<void> {
		const ok = await this.modelAdmin.activateProviderKey(provider, keyName);
		// Only remember existing keys — a failed switch (deleted key) must not
		// plant a stale reference that errors on every later project switch.
		if (ok) this.stateStore.saveProjectProviderKey(this.clientId, this.cwd, provider, keyName);
		else this.stateStore.deleteProjectProviderKey(this.clientId, this.cwd, provider);
	}
	async removeProviderKey(provider: string, keyName: string): Promise<void> {
		await this.modelAdmin.removeProviderKey(provider, keyName);
		// The deletion may have been made from another project: every project
		// still pinned to the deleted key must follow the key that took over
		// (or drop the pin when no keys remain), not just the current one.
		const active = this.modelAdmin.getActiveKeyName(provider);
		this.stateStore.repointDeletedKeyEverywhere(provider, keyName, active);
	}

	/** Restore per-project provider keys when entering a project. For each
	 *  provider that has a saved key for `cwd`, activate it if it differs from
	 *  the current global active. Silent + self-healing: a saved key deleted
	 *  elsewhere is dropped without notifying (a noisy error here is what
	 *  haunted project switches after a key deletion). */
	private async restoreProjectProviderKeysForCwd(cwd: string): Promise<void> {
		const saved = this.stateStore.getProjectProviderKeys(this.clientId, cwd);
		if (!saved) return;
		for (const [provider, keyName] of Object.entries(saved)) {
			const cur = this.modelAdmin.getActiveKeyName(provider);
			if (cur === keyName) continue;
			if (!this.modelAdmin.hasProviderKey(provider, keyName)) {
				this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
				continue;
			}
			const ok = await this.modelAdmin.activateProviderKey(provider, keyName, { silent: true });
			if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
		}
	}

	/** When a model is set, ensure its provider's per-project key is restored.
	 *  Silent + self-healing like the bulk restore above. */
	private async restoreKeyForModel(modelId: string, cwd: string): Promise<void> {
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const saved = this.stateStore.getProjectProviderKey(this.clientId, cwd, provider);
		if (!saved) return;
		const cur = this.modelAdmin.getActiveKeyName(provider);
		if (cur === saved) return;
		if (!this.modelAdmin.hasProviderKey(provider, saved)) {
			this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
			return;
		}
		const ok = await this.modelAdmin.activateProviderKey(provider, saved, { silent: true });
		if (!ok) this.stateStore.deleteProjectProviderKey(this.clientId, cwd, provider);
	}

	/** Remember the just-selected model (and the key that was active for its
	 *  provider) for the current project. Called IMMEDIATELY on model selection —
	 *  not only after a turn — so switching back to the project restores the exact
	 *  {model, key} left behind, even for a fresh conversation with no assistant
	 *  message yet (the SDK only flushes a model_change to disk once one exists). */
	private rememberProjectModel(modelId: string): void {
		const cwd = this.cwd;
		this.stateStore.saveProjectModel(this.clientId, cwd, modelId);
		const slash = modelId.indexOf("/");
		if (slash <= 0) return;
		const provider = modelId.slice(0, slash);
		const active = this.modelAdmin.getActiveKeyName(provider);
		if (active) this.stateStore.saveProjectProviderKey(this.clientId, cwd, provider, active);
	}

	/** Restore the project's remembered model (and its provider's key) onto the
	 *  ACTIVE conversation — but ONLY for a conversation the user hasn't really
	 *  started (no messages yet). A conversation that already has content keeps its
	 *  own per-session model: switching back to a RUNNING / completed chat must not
	 *  silently overwrite its model with the project default. So a fresh chat in the
	 *  project gets the remembered model; an in-progress one keeps what it had and
	 *  the user switches via the picker. Silent on failure (model no longer in catalog).
	 *
	 *  Returns true when the active conversation's model was actually changed —
	 *  callers that already emitted the switch snapshot flush again on true so
	 *  the client's model chip catches up (see restoreProjectDefaults). */
	private async restoreProjectModelForCwd(cwd: string): Promise<boolean> {
		const savedModel = this.stateStore.getProjectModel(this.clientId, cwd);
		if (!savedModel) return false;
		try {
			if (this.conv.session.getSessionStats().totalMessages > 0) return false;
		} catch {
			return false;
		}
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = savedModel.indexOf("/");
			if (slash <= 0 || slash === savedModel.length - 1) return false;
			const model = mr.getModel(savedModel.slice(0, slash), savedModel.slice(slash + 1));
			if (!model) return false;
			const cur = this.session.model;
			const curId = cur ? `${cur.provider}/${cur.id}` : null;
			// Restore the model's provider key first so setModel's auth check passes.
			await this.restoreKeyForModel(savedModel, cwd);
			if (curId === savedModel) return false;
			await this.session.setModel(model);
			return true;
		} catch {
			// model no longer resolvable / key gone — keep the conversation default
			return false;
		}
	}

	/** Per-project restores that follow EVERY switch into a project (provider
	 *  keys, then the remembered model). Both can await the model runtime, so
	 *  they run AFTER the switch snapshot has gone out — the client shows the
	 *  new conversation immediately and only the model chip trails. A second
	 *  snapshot is flushed when the model actually changed; nothing else these
	 *  restores touch is part of UiState. */
	private async restoreProjectDefaults(cwd: string): Promise<void> {
		await this.restoreProjectProviderKeysForCwd(cwd);
		if (await this.restoreProjectModelForCwd(cwd)) this.flushSnapshot();
	}

	// ---------------------------------------------------------------------------
	// Settings (system prompt / skills / extensions / presets)
	// ---------------------------------------------------------------------------

	/** Push the full settings state (current settings + loaded skills/extensions
	 *  with enabled flags + saved presets). Pushed on attach and after every
	 *  settings change. */
	pushSettings(): void {
		this.settingsSvc.push();
	}

	/** 把设置面板的出错重试次数注入全部存活会话的 SDK SettingsManager。
	 *  applyOverrides 只改内存合并视图（不碰 ~/.pi/agent/settings.json），
	 *  且 SDK 每次退避前都重读 getRetrySettings()——即时生效、无需 reload。
	 *  但 session.reload() 会重读磁盘丢掉覆盖，每次 reload 后必须重放
	 *  （reloadSession / afterReload / 标记开关直载路径均已接）。 */
	applyRetryOverrides(): void {
		const n = normalizeRetryMaxAttempts(this.settingsSvc.current.retryMaxAttempts);
		for (const c of this.convs.values()) {
			try {
				c.session.settingsManager.applyOverrides({ retry: { maxRetries: n } });
			} catch {
				// 会话未就绪或已释放 → 其 runtime 创建时统一注入。
			}
		}
	}

	/** Extensions/skills changed externally (e.g. `pi remove` finished in the
	 *  terminal): re-run session.reload() and re-push state. Streaming-safe —
	 *  deferred to agent_end, same as settings reloads. */
	async reloadExtensions(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** Persist + apply a partial settings update (prompt text/mode, toggles). */
	async setSettings(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledAgentTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		questionnaireEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		skillsFullText?: string[];
		retryMaxAttempts?: number;
	}): Promise<void> {
		await this.settingsSvc.set(partial);
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		return this.settingsSvc.savePreset(name);
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		return this.settingsSvc.applyPreset(name);
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		return this.settingsSvc.deletePreset(name);
	}

	/** Make settings effective in the running runtime（流式中则延迟到 agent_end）。 */
	private async applyRuntimeSettings(): Promise<void> {
		return this.settingsSvc.applyRuntime();
	}

	/** 统一工具门控（tool_manage 唯一落点）：按 disabledAgentTools 把目录内工具
	 *  逐个加回/剔除活跃集（工具仍留在注册表，重开可直接加回；live 生效无需
	 *  reload）。session.reload() 与新会话创建都会把 custom 工具加回活跃集，
	 *  所以这两条路径之后都要重放本方法（见 reloadSession/创建处）。 */
	private applyToolGating(session: AgentSession): void {
		applyAgentToolsGating(session, effectiveDisabledAgentTools(this.settingsSvc.current));
		// SDK 的 setActiveToolsByName 只改 agent.state.tools，不派发任何事件——门控后
		// 主动推一次快照，否则快照里的 tools 要等下一个 SDK 事件才对齐（会话空闲时永远
		// 等不到；回归：tests/terminal-smoke-test.mjs「agent exposes persistent terminal tools」）。
		// 只在被门控的就是活跃会话时推（创建早期活跃对话可能还没绑定；创建流程自带快照）。
		const active = this.convs.get(this.activeId);
		if (active && active.session === session) this.flushSnapshot();
	}

	private async applySettingsReload(): Promise<void> {
		// 兼容旧入口：reload + 刷目录在宿主回调里完成
		return this.settingsSvc.applyRuntime();
	}

	/** Server strings are English-only; kept as a hook for the lang plumbing. */
	getLang(): ServerLang {
		return resolveServerLang();
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	/** True when the service is draining (quiesced): emits a rejection notice
	 *  and returns true. Guards every NEW-work entry point (prompt / new chat /
	 *  edit-resend / session resume / goal wizard) — existing runs keep going.
	 *  Called BEFORE any LLM/token work starts so quiesce is a hard admission
	 *  gate, not a best-effort hint. */
	private quiesceBlocked(): boolean {
		if (!this.isQuiesced()) return false;
		this.emit({
			type: "notice",
			level: "error",
			text: "Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
		});
		this.flushSnapshot();
		return true;
	}

	/** Conversations with an in-flight run — active work for quiesce status. */
	activeConversations(): number {
		let n = 0;
		for (const c of this.convs.values()) {
			try {
				if (c.session.isStreaming) n += 1;
			} catch {
				// session being replaced — not running
			}
		}
		return n;
	}

	/** Messages queued in the SDK (steer + follow-up) — pending work for
	 *  quiesce status. Quiesce refuses to add more, so this only drains. */
	pendingMessages(): number {
		let n = 0;
		for (const c of this.convs.values()) n += c.queueFollowUp.length + c.queueSteering.length;
		return n;
	}

	async prompt(
		text: string,
		attachments?: {
			path: string;
			mode?: "inline" | "reference" | "lines";
			lines?: { start: number; end: number };
			/** Raw pasted/dropped/uploaded image (base64) — bypasses workspace path. */
			imageData?: string;
			/** Raw uploaded file bytes (base64) — persisted, attached as reference. */
			fileData?: string;
			mimeType?: string;
			name?: string;
			size?: number;
		}[],
		/**
		 * true = followUp: while streaming, queue the prompt and deliver it only
		 * after the WHOLE run finishes (补充 button — "AI 生成结束才发送").
		 * false/undefined = steer: the pi CLI Enter semantic — injected right
		 * after the current turn settles, skipping remaining planned tool calls.
		 */
		queue = false,
	): Promise<void> {
		// A switch_session preview is on screen and its runtime is still
		// booting: the conversation the user is typing into does not exist yet
		// (UiState.booting). Refuse rather than deliver to the PREVIOUS chat.
		if (this.bootingSwitches.size > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "The conversation is still opening — wait a moment and send again.",
			});
			return;
		}
		// Captured at the START (before any await): the conversation being
		// addressed by this prompt. See the naming block below — a concurrent
		// switch/new_chat while prompt() is in flight must never target a
		// different conversation.
		const conv = this.conv;
		try {
			const s = this.session;
			// Native slash commands (see NATIVE_COMMANDS) are executed here and
			// never reach the SDK. Extension / skill / template commands fall
			// through — AgentSession.prompt() handles those itself.
			const slash = parseSlash(text);
			if (slash && (await this.slash.exec(slash.name, slash.args))) {
				this.flushSnapshot();
				return;
			}
			// Native commands above are pure config tweaks (no tokens) — allow them
			// even while quiesced. Everything that reaches the SDK is NEW work and
			// is refused until admission reopens.
			if (this.quiesceBlocked()) return;
			// Name the conversation from its FIRST prompt immediately, before any
			// await: the typed text IS the name. The `conv` reference was captured
			// before the try block, so a concurrent switch/new_chat while prompt()
			// is in flight can never rename a DIFFERENT conversation — or miss the
			// rename entirely. A failed send still leaves the name, which matches
			// what the user typed intent-wise; the entry_appended fallback below
			// re-derives it from the persisted transcript when needed.
			if (conv.title === DEFAULT_CONV_TITLE && text.trim() && !conv.session.sessionName?.trim()) {
				const trimmed = text.trim().replace(/\s+/g, " ");
				conv.title = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
				this.emitConversations();
			}
			// Attach files as independent nextTurn context messages (asides) so the
			// user message stays clean; they render as separate attachment cards.
			const asides = await buildAttachmentMessages(
				{
					cwd: this.cwd,
					clientId: this.clientId,
					emit: (msg) => this.emit(msg),
					settings: this.settingsSvc.current,
					session: this.session,
					// issue #91：附件/视觉桥文案按客户端 UI 语言出中英（英文默认）。
					getLang: () => this.getLang(),
				},
				attachments,
			);
			for (const aside of asides) {
				await s.sendCustomMessage(aside.message, { deliverAs: "nextTurn" });
			}
			if (s.isStreaming) {
				// queue=true (补充 button) → followUp: the message is delivered only
				// after the whole run finishes — the agent finishes what it started,
				// then responds to the queued message. queue=false/undefined
				// (plain Enter) → steer: interrupts the current run — the message
				// is delivered right after the current assistant turn settles
				// (remaining planned tool calls are skipped) and the agent
				// immediately responds to it. This is the pi CLI
				// Enter-during-streaming semantic (docs/usage: Enter queues a
				// steering message); followUp would wait for the whole run
				// to finish, which users perceive as ordinary queueing.
				await s.prompt(text, {
					streamingBehavior: queue ? "followUp" : "steer",
				});
			} else {
				await s.prompt(text);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to send prompt: ${(err as Error).message}`,
			});
		}
		// The active conversation (captured at prompt start — see above) has been
		// continued since it was opened — it must not be dismissed when the user
		// switches away. (Also bumps the per-project "most recently active"
		// order used by set_cwd.)
		conv.promptedSinceActive = true;
		conv.lastActiveAt = Date.now();
		// Fresh run — restart the stall watchdog window.
		conv.lastSdkEventAt = Date.now();
		conv.stallNoticed = false;
		this.flushSnapshot();
	}

	/**
	 * Turn attached files into custom-message payloads.
	 *
	 * Text files are size-aware: small files are inlined into the message so the
	 * model sees them immediately; large files are passed as a <file path="...">
	 * reference and the model reads them on demand with its read tool (which has
	 * built-in truncation). Images are always passed as image content. Mode
	 * "lines" inlines only a 1-based inclusive line range of the file. Raw
	 * pasted/dropped/uploaded images (attachment.imageData) skip the workspace
	 * path entirely and go straight to the model as image content. Raw uploaded
	 * files (attachment.fileData) are persisted under <dataDir>/uploads/ and
	 * attached as absolute-path references (small text ones are inlined).
	 */

	/**
	 * Hard-abort the running agent (Stop button / global 中断). Tries
	 * session.abort() first; if the run is not idle within
	 * HARD_ABORT_TIMEOUT_MS (model stream ignoring the abort signal), the
	 * conversation's runtime is force-disposed and recreated from the last
	 * persisted session so the chat ALWAYS comes back usable — never stuck
	 * overnight. The notice fires only on the forced-reset path.
	 */
	async abort(): Promise<void> {
		// 只停止智能体运行本身；AI 在后台启动的服务由「后台任务」面板单独
		// 管理（可逐个停止或全部关闭），不会在停止对话时被连带杀掉。
		await this.interruptRun(this.conv, "已停止");
		this.flushSnapshot();
	}

	/** 手动重试上次失败的模型调用：自动重试次数（retryMaxAttempts）用完后
	 *  本轮已停止并标红，用户点「重试」再触发一轮 LLM 调用。不新增用户气泡——
	 *  用 display:false 的 custom 消息 triggerTurn 续跑，模型基于完整上下文
	 * （含上次报错）继续生成。流式中 / 无可重试失败时只发 notice 拒绝。 */
	async retryLast(): Promise<void> {
		const conv = this.conv;
		try {
			if (this.quiesceBlocked()) return;
			const s = this.session;
			if (s.isStreaming) {
				this.emit({
					type: "notice",
					level: "info",
					text: "The conversation is still generating — no need to retry",
				});
				return;
			}
			if (conv.retryState) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Auto-retry is in progress — please wait",
				});
				return;
			}
			// 最后一轮失败的证据：末尾 stopReason=error 的 assistant 消息。
			let failed: { errorMessage?: unknown; stopReason?: unknown } | null = null;
			try {
				const msgs = s.agent.state.messages;
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i] as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
					if (m.role !== "assistant") continue;
					if ((typeof m.errorMessage === "string" && m.errorMessage.trim()) || m.stopReason === "error") {
						failed = m;
					}
					break;
				}
			} catch {
				// 会话替换中——按无可重试处理
			}
			if (!failed) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Nothing to retry: the last turn did not end with an error",
				});
				return;
			}
			await s.sendCustomMessage(
				{
					customType: "manual-retry",
					content: [
						{
							type: "text",
							text: "（系统：用户点击了「重试」。请基于完整上下文重新发起上一次失败的模型请求，继续完成用户的任务。）",
						},
					],
					display: false,
				},
				{ triggerTurn: true },
			);
			conv.promptedSinceActive = true;
			conv.lastActiveAt = Date.now();
			conv.lastSdkEventAt = Date.now();
			conv.stallNoticed = false;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Manual retry failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Remove ONE queued prompt text (the ✕ on a pending bubble) so it is neither
	 * shown nor eventually delivered. The pi SDK has no per-item queue API, so we
	 * drain the SDK queue (clearQueue), drop the target text and re-queue the rest
	 * in their original order; the SDK re-emits queue_update which re-syncs
	 * conv.queueSteering / conv.queueFollowUp.
	 */
	async removeQueued(kind: "steer" | "followUp", text: string): Promise<void> {
		const conv = this.conv;
		// Always-defined display mirrors; also the provenance of bubble rendering.
		const local = kind === "steer" ? conv.queueSteering : conv.queueFollowUp;
		if (!local.includes(text)) {
			// Already gone (delivered / cleared elsewhere) — just refresh the display.
			this.flushSnapshot();
			return;
		}
		const s = this.conv.session;
		if (!s) {
			// Runtime not bound yet (fresh conversation) — drop the display mirror;
			// a later queue_update reconciles any SDK-side state.
			const i = local.indexOf(text);
			if (i >= 0) local.splice(i, 1);
			this.flushSnapshot();
			return;
		}
		const { steering, followUp } = s.clearQueue();
		// 只移除第一条匹配：气泡 ✕ 对应的是「一条」消息，重复文本不能连带删除
		// （旧实现用值过滤会把所有同文本项一起删掉，与本地显示镜像不一致）。
		const keptSteering = kind === "steer" ? removeFirstOccurrence(steering, text) : steering;
		const keptFollowUp = kind === "followUp" ? removeFirstOccurrence(followUp, text) : followUp;
		// Re-queue the survivors in original order. Guard each call so a single
		// failure can't leave the queue half-drained silently.
		for (const t of keptSteering) {
			try {
				await s.steer(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Failed to re-queue the steer message: ${(err as Error).message}`,
				});
			}
		}
		for (const t of keptFollowUp) {
			try {
				await s.followUp(t);
			} catch (err) {
				this.emit({
					type: "notice",
					level: "error",
					text: `Failed to re-queue the queued message: ${(err as Error).message}`,
				});
			}
		}
		this.flushSnapshot();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listBgServers(): Promise<void> {
		await this.bg.listAndPush();
	}

	/** 插件任务集合变化时由宿主调用：重推一次 bg_servers（含插件任务）。 */
	refreshBgTasks(): void {
		this.bg.push();
	}

	/** For index.ts paths that need to emit a notice (emit is private). */
	emitNotice(level: "info" | "warning" | "error", text: string): void {
		this.emit({ type: "notice", level, text });
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	async killBackgroundServer(port: number | undefined): Promise<boolean> {
		if (typeof port !== "number") return false;
		return this.bg.killOne(port);
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAllBackgroundServers(): Promise<string[]> {
		return this.bg.killAll();
	}

	/** Kill only the running bash command(s) — the agent run itself continues
	 *  (the bash tool returns an aborted error and the model moves on). Uses
	 *  the per-client AbortController set registered by the bash tool paths
	 *  ({@link makeKillableBashTool} / {@link makeTerminalBashTool}). */
	async abortBash(): Promise<void> {
		if (this.bashKills.size === 0) {
			this.emit({
				type: "notice",
				level: "info",
				text: "No bash command is running",
			});
			this.flushSnapshot();
			return;
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const ac of [...this.bashKills]) ac.abort();
		this.emit({
			type: "notice",
			level: "info",
			text: "Bash command stopped (conversation continues)",
		});
		// 让 AI 明确知道是用户手动停止：sendUserMessage 触发下一轮，agent
		// 会看到「命令被用户中止」而不是普通失败，并据此继续（不会困惑于
		// 为什么命令失败了）。
		try {
			await this.conv.runtime.session.sendUserMessage(
				"（系统：用户手动停止了刚才的 bash 命令——命令被中止，终止前已输出的内容在对应工具结果里。请据此继续，不要重跑被中止的命令，除非确实必要。）",
			);
		} catch {
			// best effort — 消息注入失败不影响命令已停止的事实
		}
		this.flushSnapshot();
	}

	/** Interrupt a run: abort, with a force-reset fallback on timeout. */
	private async interruptRun(conv: Conversation, reason: string): Promise<void> {
		// Abort is a user/host interruption, never a completed or failed run.
		conv.notificationLifecycle.abort();
		// The run is only truly stopped when its agent_end event arrives:
		// session.abort() can return without stopping anything when the run is
		// stuck before the agent even started (e.g. a model stream that never
		// begins), so we watch for agent_end and force-reset when it never
		// comes — abort 卡住（超时）或空转（结算窗口）两条路都覆盖。
		let ended = false;
		let forced = false;
		const off = conv.session.subscribe((e) => {
			if (e.type === "agent_end") {
				ended = true;
			}
		});
		const force = () => {
			if (forced) return;
			forced = true;
			void this.forceResetConversation(conv, `${reason}：运行未终止，已强制重置当前对话`);
		};
		// 1) abort itself hangs (model stream ignores the signal) → hard kill.
		const abortTimer = setTimeout(() => {
			if (!ended) force();
		}, ClientSession.HARD_ABORT_TIMEOUT_MS);
		abortTimer.unref?.();
		// 2) abort itself (Stop semantics: kills the process tree, emits
		//    agent_end with stopReason "aborted" on the normal path).
		try {
			await conv.runtime.session.abort();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Abort failed: ${(err as Error).message}`,
			});
		}
		// 3) abort returned but no agent_end within the settle window → the
		//    run was stuck before it started; force-reset to recover.
		if (!ended) {
			await new Promise((r) => setTimeout(r, ClientSession.HARD_ABORT_SETTLE_MS));
		}
		clearTimeout(abortTimer);
		off();
		if (!ended) force();
	}

	/** Force-reset a conversation: dispose the stuck runtime (kills the hung
	 *  model stream / child processes) and rebuild it from the most recent
	 *  persisted session. The conversation record itself is kept (same id,
	 *  same cwd, same serialization caches), so the UI stays attached. */
	private async forceResetConversation(conv: Conversation, reason: string): Promise<void> {
		try {
			// Refresh the in-memory todo state while the run is still live, so its
			// membership survives the hand-off. Then end tracking before disposal
			// (which cannot be allowed to emit a late agent_end). The replacement
			// bind skips replay: replaying an ended run would replace these ids with
			// the historical branch boundary and lose the useful last-run strip.
			const todos = this.todosFor(conv);
			this.replayTodos(conv, todos);
			todos.endRun();
			this.pushTodosIfActive(conv);
			conv.unsubscribe?.();
			conv.unsubscribe = undefined;
			conv.notificationLifecycle.reset();
			this.clearAllToolWatchdogs(conv);
			conv.toolStartTimes.clear();
			await conv.runtime.dispose();
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(conv.terminals, conv.id), {
				cwd: conv.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.continueRecent(conv.cwd),
			});
			conv.runtime = runtime;
			conv.session = runtime.session;
			this.emit({
				type: "notice",
				level: "warning",
				text: `${reason} (forced reset: run did not terminate)`,
			});
			await this.bindSession(true);
			this.emitConversations();
			void this.pushSlashCommands();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Force-stop failed: ${(err as Error).message}`,
			});
		}
	}

	private get projectlessCwd(): string {
		return join(this.stateStore.dataDir, "chats");
	}

	/**
	 * New chat, optionally in another workspace (`cwd`; null = the projectless
	 * chats folder). Two shapes:
	 *
	 * - the target already has an open conversation (or is the current
	 *   workspace): switch there (set_cwd semantics) and then reuse / create
	 *   the blank chat exactly as a plain new_chat would;
	 * - the target has NO open conversation: boot the blank runtime directly
	 *   in the new workspace (newChatInWorkspace). Going through set_cwd
	 *   first would resume the project's most recent session — a full
	 *   runtime — only to displace and dispose it a moment later for the
	 *   blank one the user actually asked for.
	 */
	async newChat(cwd?: string | null): Promise<boolean> {
		if (this.quiesceBlocked()) return false;
		if (cwd !== undefined) {
			let target: string | null;
			if (cwd === null) {
				target = this.projectlessCwd;
				mkdirSync(target, { recursive: true });
			} else {
				try {
					target = await this.resolveWorkspaceTarget(cwd);
				} catch (err) {
					this.emit({
						type: "notice",
						level: "error",
						text: `Failed to switch directory: ${(err as Error).message}`,
					});
					target = null;
				}
				if (target === null) {
					this.flushSnapshot();
					return false;
				}
			}
			const hasOpenConversation = [...this.convs.values()].some((c) => c.cwd === target);
			if (target !== this.cwd && !hasOpenConversation) {
				return this.newChatInWorkspace(target);
			}
			await this.setCwd(target);
			if (this.cwd !== target) return false;
		}
		// Reuse an already-open blank conversation instead of piling up new ones
		// on every click: if the active chat has no messages it IS the new chat
		// (focus already on it); otherwise switch to the first blank one (under
		// the per-project running-list model displaced blanks are disposed, so
		// this branch normally can't exist — kept as a safety net).
		const isBlank = (c: Conversation): boolean => {
			try {
				return c.session.getSessionStats().totalMessages === 0 && c.terminals.list().length === 0;
			} catch {
				// session being replaced — treat as used so we don't switch onto it
				return false;
			}
		};
		const active = this.conv;
		if (active && isBlank(active)) {
			this.flushSnapshot();
			return true;
		}
		for (const conv of this.convs.values()) {
			if (conv.id === this.activeId) continue;
			if (conv.cwd === this.cwd && isBlank(conv)) {
				await this.switchConversation(conv.id);
				this.flushSnapshot();
				return true;
			}
		}
		// Cap is per project — conversations of other projects keep their own
		// lists and don't consume this project's slots.
		const openInProject = [...this.convs.values()].filter((c) => c.cwd === this.cwd).length;
		if (openInProject >= MAX_OPEN_CONVERSATIONS) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
			});
			return false;
		}
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle. Removal is deferred until the new chat exists so the active
		// conversation stays valid during the (async) runtime creation.
		const displaced = this.displaceActive();
		// Carry the model chosen in the active chat over to the new chat so it
		// doesn't silently revert to the ModelRuntime default model.
		const prevModel = this.conv.session.agent.state.model ?? null;
		let ready = false;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, this.cwd);
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, conversationId), {
				cwd: this.cwd,
				agentDir: this.agentDir,
				sessionManager: SessionManager.create(this.cwd),
			});
			const conv = this.makeConversation(runtime, conversationId, terminals);
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			// A fresh transcript appeared in the sessions dir — the next listing
			// must see it, not the pre-newChat fridge snapshot.
			this.invalidateSessionInfos();
			// New session seeds with the ModelRuntime default model — restore the
			// model the user had selected in the previous chat.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
					const p = (prevModel as unknown as { provider: string }).provider;
					const mid = `${p}/${(prevModel as unknown as { id: string }).id}`;
					await this.restoreKeyForModel(mid, this.cwd);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			this.emitConversations();
			this.pushTerminals();
			// The new runtime re-discovered skills/templates — refresh the catalog
			// so the picker stops showing the previous runtime's list.
			void this.pushSlashCommands();
			ready = true;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to create chat: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
		return ready;
	}

	/**
	 * Blank chat in a workspace the client has no open conversation in: ONE
	 * runtime (SessionManager.create) that is both the project switch and the
	 * new chat. Mirrors set_cwd's project-switch side-effects (followWorkspace
	 * / activateFreshConversation) and new_chat's bookkeeping (session-list
	 * invalidation, model carry-over). The per-project cap cannot be hit here
	 * — the project has zero open conversations by definition.
	 */
	private async newChatInWorkspace(abs: string): Promise<boolean> {
		this.files.unwatchGit(); // stale repo's watcher must not fire across projects
		// The outgoing conversation is left behind — apply the running-list
		// lifecycle (removal is deferred until the new chat exists). Roll the
		// presentation-only `listed` promotion back if the boot fails.
		const outgoing = this.conv;
		const oldListed = outgoing.listed;
		const displaced = this.displaceActive();
		// Carry the previously active chat's model over when the target project
		// has no remembered model of its own (restoreProjectDefaults wins
		// otherwise) — a blank runtime seeds with the ModelRuntime default.
		const prevModel = outgoing.session.agent.state.model ?? null;
		try {
			const conversationId = this.nextConversationId();
			const terminals = this.makeTerminalManager(conversationId, abs);
			const runtime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, conversationId), {
				cwd: abs,
				agentDir: this.agentDir,
				sessionManager: SessionManager.create(abs),
			});
			await this.activateFreshConversation(this.makeConversation(runtime, conversationId, terminals), displaced);
		} catch (err) {
			outgoing.listed = oldListed;
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to create chat: ${(err as Error).message}`,
			});
			this.flushSnapshot();
			return false;
		}
		// A fresh transcript appeared in the sessions dir — the next listing
		// must see it, not the pre-newChat fridge snapshot.
		this.invalidateSessionInfos();
		this.followWorkspace(abs, true);
		// Snapshot first, then the awaited restores (model chip may trail).
		this.flushSnapshot();
		await this.restoreProjectProviderKeysForCwd(abs);
		let modelChanged = await this.restoreProjectModelForCwd(abs);
		if (!modelChanged && prevModel && this.sharedModelRuntime) {
			const cur = this.session.model;
			if (!cur || cur.provider !== prevModel.provider || cur.id !== prevModel.id) {
				try {
					await this.session.setModel(prevModel);
					await this.restoreKeyForModel(`${prevModel.provider}/${prevModel.id}`, abs);
					modelChanged = true;
				} catch {
					// model no longer resolvable — keep the default
				}
			}
		}
		if (modelChanged) this.flushSnapshot();
		return true;
	}

	/**
	 * The active conversation is being left (new_chat / switch_conversation /
	 * set_cwd). Runs the running-list lifecycle:
	 *
	 * - still streaming → it becomes a background run: ensure it is listed;
	 * - idle + listed + continued → keep it (the user did continue it);
	 * - any retained terminal state → keep it listed until the terminals are closed;
	 * - idle + listed + opened-but-not-continued, or never listed at all → the
	 *   caller must drop it (returns it so removal happens only after the
	 *   active conversation has been switched away).
	 */
	private displaceActive(): Conversation | null {
		const conv = this.conv;
		if (this.isRetained(conv)) {
			conv.listed = true;
			return null;
		}
		return conv;
	}

	/** Whether a conversation must keep its runtime alive when left behind. */
	private isRetained(conv: Conversation): boolean {
		let streaming = true;
		try {
			streaming = conv.session.isStreaming;
		} catch {
			// session being replaced — treat as running, never drop it
		}
		if (streaming) return true;
		if (conv.terminals.countLive() > 0) return true;
		return conv.listed && conv.promptedSinceActive;
	}

	/** Remove a conversation from the running list and free its runtime. The
	 *  session stays persisted on disk, so it remains recoverable from the
	 *  history list. Never removes the active conversation. */
	private removeConversation(id: string): void {
		const conv = this.convs.get(id);
		if (!conv || id === this.activeId) return;
		this.convs.delete(id);
		this.convStatuses.remove(id);
		this.convTodos.delete(id);
		this.dropWorkerState(id);
		this.clearAllToolWatchdogs(conv);
		conv.notificationLifecycle.reset();
		conv.terminals.killAll();
		conv.unsubscribe?.();
		conv.unsubscribe = undefined;
		void conv.runtime.dispose().catch(() => {});
	}

	/** Switch the ACTIVE conversation without interrupting any other chat. */
	async switchConversation(id: string): Promise<void> {
		if (!this.convs.has(id) || id === this.activeId) return;
		const displaced = this.displaceActive();
		this.activeId = id;
		const newCwd = this.conv.cwd;
		// A listed conversation may belong to ANOTHER project (cross-project
		// running list). Switching to it must also switch the active workspace
		// — otherwise the file tree / session history / recent-projects order
		// would keep showing the OLD project while the chat shows the new one.
		const cwdChanged = newCwd !== this.cwd;
		if (displaced) this.removeConversation(displaced.id);
		this.conv.promptedSinceActive = false;
		this.conv.lastActiveAt = Date.now();
		if (cwdChanged) {
			// Mirror set_cwd's project-switch side-effects so the whole UI follows
			// the new workspace, not just the chat pane. Follow the chat's
			// workspace, but don't promote it to a project — a CLI session from
			// an arbitrary shell directory stays under Recents.
			this.followWorkspace(newCwd, false);
		} else {
			this.webUi.refresh();
			// Replay the switched-to conversation's OWN extension statuses (role
			// footer). Without this, the client keeps showing the previous chat's
			// role even though the tools/model belong to the new chat (issue #116).
			this.pushActiveStatuses();
			this.emitConversations();
			this.pushTerminals();
			// The switched-to conversation has its own runtime (own resource cache).
			void this.pushSlashCommands();
		}
		// The snapshot is what the user is waiting for — it goes out before the
		// awaited per-project restores (which re-flush only if the model moved).
		this.flushSnapshot();
		if (cwdChanged) await this.restoreProjectDefaults(newCwd);
	}

	/** Push every running conversation across ALL projects to the client. The
	 *  running-conversation list is global so a background run from another
	 *  workspace stays visible; clicking one switches both the conversation and
	 *  its project (see switchConversation). The client groups the list by cwd. */
	private emitConversations(): void {
		const conversations: ConversationSummary[] = [];
		for (const conv of this.convs.values()) {
			if (!conv.listed) continue;
			let messageCount = 0;
			let isStreaming = false;
			let sessionPath: string | undefined;
			try {
				messageCount = conv.session.getSessionStats().totalMessages;
				isStreaming = conv.session.isStreaming;
				sessionPath = conv.session.sessionFile ?? undefined;
			} catch {
				// session being replaced — report defaults
			}
			conversations.push({
				id: conv.id,
				title: conv.title,
				cwd: conv.cwd,
				messageCount,
				isStreaming,
				sessionPath,
			});
		}
		this.emit({
			type: "conversations",
			conversations,
			activeId: this.activeId,
		});
	}

	/** List persisted sessions for this client, newest first. */
	/** The client asked for the session list at least once (lazy loading) —
	 *  background refreshes only re-push when this is true, so a mobile
	 *  client that never opened the panel never pays the disk scan. */
	private sessionsRequested = false;

	/**
	 * Last parsed session lists, keyed by cwd and cached briefly so repeated
	 * global-search keystrokes don't re-parse every transcript file on each
	 * request (a project can hold 100+ sessions of several MB each).
	 * pushSessions() and searchSessions() share this fridge — opening the
	 * panel (or expanding a project group) warms it, then every keystroke
	 * inside the TTL is free. Keyed by cwd so a non-current project's listing
	 * never pollutes or races the active cwd's fridge.
	 */
	private sessionInfosCache = new Map<string, { infos: SessionInfo[]; at: number }>();
	/** `git worktree list` per repository, keyed by the folded path of EVERY
	 *  checkout of that repository so sibling worktrees share one git call.
	 *  Short TTL: pushProjects runs on each list_projects and after every
	 *  project switch. */
	private worktreeCache = new Map<string, { list: GitWorktree[]; at: number }>();
	private static readonly WORKTREE_CACHE_TTL = 5000;

	private async repoWorktrees(dir: string): Promise<GitWorktree[]> {
		const now = Date.now();
		const c = this.worktreeCache.get(cwdKey(dir));
		if (c && now - c.at < ClientSession.WORKTREE_CACHE_TTL) return c.list;
		const list = (await listWorktrees(dir)).filter((w) => !w.prunable && !w.bare);
		const entry = { list, at: now };
		this.worktreeCache.set(cwdKey(dir), entry);
		for (const w of list) this.worktreeCache.set(cwdKey(w.path), entry);
		return list;
	}

	/** Folded cwd key → the spelling the sidebar groups under. Transcripts can
	 *  store a cwd in another case (`c:\...` from a CLI run); listings and
	 *  refreshes must be echoed under the canonical spelling or the client ends
	 *  up with two lists for one directory. Rebuilt by pushProjects(). */
	private canonicalCwd = new Map<string, string>();

	private canonicalize(cwd: string): string {
		return this.canonicalCwd.get(cwdKey(cwd)) ?? cwd;
	}
	private static readonly SESSION_INFO_CACHE_TTL = 3000;

	/** How many non-project directories get their sessions pushed for "Recents". */
	private static readonly RECENT_CWD_CAP = 12;

	private async loadSessionInfos(cwd: string = this.cwd): Promise<SessionInfo[]> {
		const now = Date.now();
		const c = this.sessionInfosCache.get(cwd);
		if (c && now - c.at < ClientSession.SESSION_INFO_CACHE_TTL) {
			return c.infos;
		}
		const infos = await SessionManager.list(cwd, piSessionsRoot());
		this.sessionInfosCache.set(cwd, { infos, at: now });
		return infos;
	}

	/** Session files on disk changed (delete / new-transcript) — drop the brief
	 *  TTL fridge so the NEXT listing re-reads the directory instead of serving
	 *  the pre-mutation snapshot (delete-then-refresh commonly runs inside the
	 *  window, which would re-push the just-removed session). Scoped by cwd:
	 *  only the mutated project's entry is dropped; omit cwd to drop all. */
	private invalidateSessionInfos(cwd?: string): void {
		if (cwd === undefined) this.sessionInfosCache.clear();
		else this.sessionInfosCache.delete(cwd);
	}

	/** Push the persisted session list to the client (client-requested).
	 *  `cwd` scopes the listing to one project; omitted = active cwd. */
	async refreshSessions(cwd?: string): Promise<void> {
		this.sessionsRequested = true;
		await this.pushSessions(cwd);
	}

	private async pushSessions(cwd?: string): Promise<void> {
		if (!this.sessionsRequested) return;
		const targetCwd = this.canonicalize(cwd ?? this.cwd);
		try {
			// Sessions live in the SDK default per-project dir
			// (<agentDir>/sessions/--<cwd>--/), the same files the pi CLI/TUI
			// use — one listing covers every conversation of one folder. The
			// echoed `cwd` lets the client attribute the reply to the right
			// project group even when several scoped queries are in flight.
			const infos = await this.loadSessionInfos(targetCwd);

			const sessions = new Map<string, SessionSummary>();
			for (const s of infos) {
				sessions.set(s.path, {
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage,
					messageCount: s.messageCount,
					modified: s.modified.getTime(),
					source: "web",
				});
			}
			const sorted = [...sessions.values()].sort((a, b) => b.modified - a.modified); // newest first; retain older project chats
			this.emit({ type: "sessions", cwd: targetCwd, sessions: sorted });
		} catch {
			this.emit({ type: "sessions", cwd: targetCwd, sessions: [] });
		}
	}

	/**
	 * Create (or reuse) the worktree for `branch` and open a blank chat in it.
	 * The chat is an ordinary conversation whose cwd is the worktree, so every
	 * tool, terminal and delegated worker of that chat runs there — the main
	 * checkout is never touched. A worktree that was created but whose chat
	 * failed to open is kept and its path reported, as in the CLI.
	 */
	async addWorktree(cwd?: string, branch?: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		const dir = cwd ? resolve(cwd) : this.cwd;
		const name = (branch ?? "").trim() || generateWorktreeName();
		let created: { path: string; branch: string; existed: boolean };
		try {
			created = await createWorktree(dir, name);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.emit({ type: "worktree_result", op: "add", ok: false, path: dir, branch: name, error: message });
			this.emit({ type: "notice", level: "error", text: `Could not create worktree ${name}: ${message}` });
			return;
		}
		this.worktreeCache.clear();
		const opened = await this.newChat(created.path);
		this.emit({ type: "worktree_result", op: "add", ok: opened, path: created.path, branch: created.branch });
		if (!opened) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Worktree ${created.branch} is ready at ${created.path}, but no chat was opened there. Open it from the sidebar.`,
			});
		}
		void this.pushProjects();
	}

	/**
	 * Remove a linked worktree (branch kept). Idle chats open in it are closed
	 * first — their runtimes hold the directory open, which on Windows makes
	 * the delete fail — and the active chat moves to another conversation or
	 * to a blank chat in the main checkout. A streaming chat or one with live
	 * terminals refuses, like dismiss_conversation does.
	 */
	async removeWorktree(path: string, force = false): Promise<void> {
		if (this.quiesceBlocked()) return;
		const target = resolve(path);
		const refuse = (error: string) => {
			this.emit({ type: "worktree_result", op: "remove", ok: false, path: target, error });
			this.emit({ type: "notice", level: "warning", text: error });
		};
		const inTarget = [...this.convs.values()].filter((c) => sameWorktreePath(c.cwd, target));
		for (const c of inTarget) {
			let streaming = true;
			try {
				streaming = c.session.isStreaming;
			} catch {
				/* runtime being replaced — treat as busy */
			}
			if (streaming) return refuse(`Chat "${c.title}" is still running in this worktree — stop it before removing`);
			if (c.terminals.countLive() > 0) {
				return refuse(`Chat "${c.title}" still has open terminals in this worktree — close them before removing`);
			}
		}
		if (inTarget.some((c) => c.id === this.activeId)) {
			const other = [...this.convs.values()].find((c) => c.listed && !sameWorktreePath(c.cwd, target));
			if (other) {
				await this.switchConversation(other.id);
			} else {
				const main = (await listWorktrees(target))[0]?.path;
				if (!main || !(await this.newChat(main))) {
					return refuse("Could not move the active chat out of the worktree; it was not removed");
				}
			}
			if (inTarget.some((c) => c.id === this.activeId)) {
				return refuse("Could not move the active chat out of the worktree; it was not removed");
			}
		}
		const branch = (await listWorktrees(target)).find((w) => sameWorktreePath(w.path, target))?.branch ?? undefined;
		try {
			// Dirty check before closing chats, so a refused removal leaves the
			// user's open chats exactly where they were.
			if (!force && (await worktreeIsDirty(target))) throw new WorktreeError("uncommitted changes", true);
			for (const c of inTarget) this.removeConversation(c.id);
			if (inTarget.length > 0) this.emitConversations();
			const removed = await removeWorktree(target, force);
			this.worktreeCache.clear();
			this.emit({ type: "worktree_result", op: "remove", ok: true, path: target, branch: removed.branch ?? undefined });
			this.emit({
				type: "notice",
				level: "info",
				text: `Removed worktree ${removed.branch ?? target} (branch kept)`,
			});
			// Its history rows still show under the project; the transcripts
			// stay on disk and can be reopened (the chat then runs in a cwd
			// that no longer exists — pi's own resume rules apply).
			void this.pushProjects();
		} catch (err) {
			const dirty = err instanceof WorktreeError && err.dirty;
			const message = err instanceof Error ? err.message : String(err);
			this.emit({ type: "worktree_result", op: "remove", ok: false, path: target, branch, dirty, error: message });
			if (!dirty) this.emit({ type: "notice", level: "error", text: `Could not remove worktree: ${message}` });
		}
	}

	/** Remove an entry from the client's recent-project list (UI state only). */
	async removeProject(path: string): Promise<void> {
		this.stateStore.removeProject(this.clientId, path);
		await this.pushProjects();
		// The client still holds this cwd's last listing; an empty echo clears
		// it so the removed project's chats don't resurface under Recents.
		this.emit({ type: "sessions", cwd: this.canonicalize(path), sessions: [] });
	}

	/** Permanently delete a persisted session transcript file (history list ✕).
	 *
	 * Deleting the ACTIVE conversation's own transcript is allowed: the session
	 * first switches away to the next-latest persisted chat (or a fresh blank
	 * chat when no other history exists). If the displacement could not release
	 * the file (streaming / open terminals / pending wake subscription /
	 * conversation cap), the deletion is aborted with a notice instead of
	 * yanking the file out of a live runtime. Background conversations still
	 * block deletion outright.
	 */
	async deleteSession(path: string): Promise<void> {
		try {
			const abs = resolve(path);
			// Guardrail: only transcripts under the shared sessions root
			// (<agentDir>/sessions/) may be deleted — never arbitrary files.
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "Only transcripts inside the session directory can be deleted",
				});
				return;
			}
			// A live conversation may hold the target transcript. A BACKGROUND
			// conversation must still block deletion outright, but when the ACTIVE
			// conversation holds it the request can be satisfied by switching away
			// first (next-latest history chat, or a fresh blank one) and letting
			// the displacement drop the old runtime.
			const holdsTarget = (conv: Conversation): boolean => {
				const file = conv.session.sessionFile;
				return file !== undefined && resolve(file) === abs;
			};
			const holder = [...this.convs.values()].find(holdsTarget);
			if (holder && holder.id !== this.activeId) {
				this.emit({
					type: "notice",
					level: "warning",
					text: "This conversation is still running — stop or close it before deleting",
				});
				return;
			}
			if (holder) {
				// Same source the history panel uses (refreshSessions): newest first.
				const infos = await SessionManager.list(this.cwd, piSessionsRoot());
				const next = infos
					.filter((s) => resolve(s.path) !== abs)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
				if (next) await this.switchSession(next.path);
				else await this.newChat();
				// displaceActive() may have RETAINED the old conversation as a
				// background run (streaming, open terminals, pending wake
				// subscription, conversation cap) — in every such case the file is
				// still held, so abort instead of yanking it from a live runtime.
				// Only a conversation that is genuinely still running in the
				// background (streaming / listed) keeps the "wait for it" notice;
				// a retained-but-idle hold means the switch itself failed (cap,
				// quiesce, runtime creation) — say that instead.
				const stillHeld = [...this.convs.values()].find(holdsTarget);
				if (stillHeld) {
					let stillRunning = stillHeld.listed;
					try {
						stillRunning = stillHeld.session.isStreaming || stillRunning;
					} catch {
						// session being replaced — keep the listed-flag fallback
					}
					this.emit({
						type: "notice",
						level: "warning",
						text: stillRunning
							? "Conversation is still running in the background; delete aborted — wait for it to finish and retry"
							: "Could not switch to another conversation; delete cancelled",
					});
					return;
				}
			}
			// Resolve the deleted transcript's project BEFORE unlinking so the
			// refresh targets that project's listing (a history entry from a
			// non-current group must refresh its OWN group, not the active cwd).
			let affectedCwd: string | undefined = holder ? this.cwd : undefined;
			if (!holder) {
				try {
					affectedCwd = SessionManager.open(abs).getCwd() || undefined;
				} catch {
					affectedCwd = undefined;
				}
			}
			rmSync(abs, { force: true });
			// Bust the brief session-info fridge for THAT project: refreshSessions()
			// below usually lands inside its 3s TTL and would otherwise re-serve a
			// listing that still contains the deleted transcript.
			this.invalidateSessionInfos(affectedCwd);
			await this.refreshSessions(affectedCwd);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to delete session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a persisted session by appending a session_info entry — the same
	 *  mechanism pi's /name uses (SessionManager.appendSessionInfo). Works on
	 *  any transcript under the sessions root, live or not; no session switch. */
	async renameSession(path: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const abs = resolve(path);
			const sessionsRoot = resolve(this.agentDir, "sessions");
			if (!abs.startsWith(sessionsRoot + sep)) {
				this.emit({
					type: "notice",
					level: "error",
					text: "Only transcripts inside the session directory can be renamed",
				});
				return;
			}
			const mgr = SessionManager.open(abs);
			mgr.appendSessionInfo(trimmed);
			this.setConversationTitleForFile(abs, trimmed);
			const affectedCwd = mgr.getCwd() || undefined;
			this.invalidateSessionInfos(affectedCwd);
			await this.refreshSessions(affectedCwd);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to rename session: ${(err as Error).message}`,
			});
		}
	}

	/** Rename a live conversation by id: retitle in memory AND persist a
	 *  session_info entry to its transcript so History matches immediately. */
	async renameConversation(id: string, name: string): Promise<void> {
		try {
			const trimmed = (name ?? "").trim();
			if (!trimmed) return;
			const conv = this.convs.get(id);
			if (!conv) return;
			conv.title = trimmed;
			let affectedCwd = conv.cwd;
			try {
				const file = conv.session.sessionFile;
				if (file !== undefined) {
					const mgr = SessionManager.open(resolve(file));
					mgr.appendSessionInfo(trimmed);
					affectedCwd = mgr.getCwd() || conv.cwd;
				}
			} catch {
				// in-memory title still updated; transcript write is best-effort
			}
			this.emitConversations();
			this.invalidateSessionInfos(affectedCwd);
			await this.refreshSessions(affectedCwd);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to rename conversation: ${(err as Error).message}`,
			});
		}
	}

	/** Point every live conversation holding this transcript file at a new title. */
	private setConversationTitleForFile(abs: string, title: string): void {
		let changed = false;
		for (const conv of this.convs.values()) {
			const file = conv.session.sessionFile;
			if (file !== undefined && resolve(file) === abs) {
				conv.title = title;
				changed = true;
			}
		}
		if (changed) this.emitConversations();
	}

	/** Dismiss a running conversation from the left-panel list without deleting its
	 *  transcript file. Only idle (non-streaming) conversations that are not
	 *  retained by terminal state can be dismissed. The session stays in
	 *  history and can be reopened. `force` aborts a running conversation first. */
	async dismissConversation(id: string, force?: boolean): Promise<void> {
		const conv = this.convs.get(id);
		if (!conv) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "This conversation does not exist or is already closed",
			});
			return;
		}
		if (!conv.listed) {
			// Not in list anyway — nothing to do.
			this.emitConversations();
			return;
		}
		const isStreaming = (c: Conversation): boolean => {
			try {
				return c.session.isStreaming;
			} catch {
				return true;
			}
		};
		if (force) {
			await this.forceDismissConversation(conv, isStreaming);
			return;
		}
		if (isStreaming(conv)) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" is still running — wait for it to finish or press Stop before removing`,
			});
			return;
		}
		if (conv.terminals.countLive() > 0) {
			this.emit({
				type: "notice",
				level: "warning",
				text: `Conversation "${conv.title}" still has open terminals — close them before removing`,
			});
			return;
		}
		// Dismissing the ACTIVE conversation: move active elsewhere first
		// (another listed conversation, else a fresh chat), then remove.
		if (id === this.activeId) {
			const vacated = await this.vacateActive(id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `Cannot dismiss the active conversation "${conv.title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		this.removeConversation(id);
		this.emitConversations();
		this.flushSnapshot();
	}
	/** Move the active marker away from id so that conversation can be removed.
	 *  Prefers another listed conversation; falls back to creating a fresh chat.
	 *  Returns true when id is no longer active. */
	private async vacateActive(id: string): Promise<boolean> {
		if (id !== this.activeId) return true;
		const other = [...this.convs.values()].find((c) => c.id !== id && c.listed);
		if (other) {
			await this.switchConversation(other.id);
		} else {
			await this.newChat();
		}
		return this.activeId !== id;
	}
	/** Force dismiss: abort the run (if any), release terminal retention and
	 *  remove. An active target is vacated first (vacateActive). */
	private async forceDismissConversation(conv: Conversation, isStreaming: (c: Conversation) => boolean): Promise<void> {
		const title = conv.title;
		let selfAborted = false;
		if (isStreaming(conv)) {
			selfAborted = true;
			await this.interruptRun(conv, "Force-dismissed");
		}
		if (conv.id === this.activeId) {
			const vacated = await this.vacateActive(conv.id);
			if (!vacated) {
				this.emit({
					type: "notice",
					level: "warning",
					text: `Cannot force-dismiss conversation "${title}" right now (no replacement chat available)`,
				});
				this.emitConversations();
				this.flushSnapshot();
				return;
			}
		}
		if (this.convs.get(conv.id) === conv && conv.id !== this.activeId) {
			this.removeConversation(conv.id);
		}
		this.emitConversations();
		this.flushSnapshot();
		this.emit({
			type: "notice",
			level: "info",
			text: `Force-dismissed conversation "${title}"${selfAborted ? ", its run was aborted" : ""}`,
		});
	}

	/**
	 * Transcript-first preview for switch_session: serialize the opened
	 * transcript through a fresh SerializeCache (no runtime needed — the
	 * serializer is pure) and emit a `snapshot` flagged `booting: true` for the
	 * conversation id the boot will use. Server state is untouched: activeId,
	 * cwd and the convs map still describe the previous conversation; only
	 * the client's view moves ahead.
	 *
	 * Rev semantics: the preview consumes one snapRev like any snapshot, and
	 * it invalidates the delta baseline (emittedMessages = null) so whatever
	 * snapshot follows — the real one for this conversation, or the fallback
	 * to the previous conversation after a failed boot — is a FULL snapshot,
	 * never a delta whose baseRev the client cannot satisfy.
	 *
	 * Returns the cache so the Conversation record adopts it: the real
	 * snapshot then reuses the preview's message ids and object references.
	 */
	private emitSessionPreview(
		sessionManager: SessionManager,
		conversationId: string,
		sessionFile: string,
	): SerializeCache {
		const cache = newSerializeCache();
		try {
			const ctx = sessionManager.buildSessionContext();
			const messages = serializeTranscript(cache, ctx.messages);
			let totalMessages = 0;
			for (const e of sessionManager.getEntries()) if (e.type === "message") totalMessages++;
			const rev = ++this.snapRev;
			this.emittedMessages = null;
			this.emittedConvId = null;
			this.emittedRev = rev;
			this.emit({
				type: "snapshot",
				state: buildPreviewState({
					clientId: this.clientId,
					cwd: sessionManager.getCwd(),
					sessionId: sessionManager.getSessionId(),
					sessionFile,
					conversationId,
					rev,
					version: ++this.version,
					messages,
					totalMessages,
					model: ctx.model,
					thinkingLevel: ctx.thinkingLevel,
					piConfigured: this.isPiConfigured(),
					piAgentInstalled: this.isPiCliInstalled(),
				}),
			});
		} catch {
			// The preview is an optimisation only — a transcript the serializer
			// chokes on still opens through the runtime below.
		}
		return cache;
	}

	/** Open a persisted session as the active conversation (from listSessions).
	 *
	 * A persisted-session click must follow the same ownership rule as
	 * new_chat/switch_conversation: every open conversation keeps its own
	 * runtime. AgentSessionRuntime.switchSession() tears down (and aborts) the
	 * current runtime, which would otherwise stop a response merely because the
	 * user opened history while it was streaming.
	 *
	 * Event sequence: (1) if the session is already open → switch_conversation;
	 * otherwise (2) a `booting` preview snapshot built from the transcript alone
	 * (emitSessionPreview), (3) the ~1s runtime boot, (4) the real full snapshot
	 * for the same conversation id. A refused (cap) or failed boot ends with a
	 * notice and a full snapshot of the still-active conversation instead, so
	 * the client falls back. Prompts are refused between (2) and (4).
	 */
	async switchSession(path: string): Promise<void> {
		if (this.quiesceBlocked()) return;
		let openedRuntime: AgentSessionRuntime | null = null;
		let openedTerminals: TerminalManager | null = null;
		let bootingId: string | null = null;
		try {
			const targetPath = resolve(path);

			// A session may already be open in the running-conversation map. Reuse it
			// instead of creating a second writer for the same JSONL transcript.
			for (const conv of this.convs.values()) {
				const sessionFile = conv.session.sessionFile;
				if (sessionFile && resolve(sessionFile) === targetPath) {
					await this.switchConversation(conv.id);
					return;
				}
			}

			const sessionManager = SessionManager.open(targetPath);
			const targetCwd = sessionManager.getCwd();
			const conversationId = this.nextConversationId();
			// Show the transcript now; the runtime catches up below.
			const cache = this.emitSessionPreview(sessionManager, conversationId, targetPath);
			bootingId = conversationId;
			this.bootingSwitches.add(conversationId);
			openedTerminals = this.makeTerminalManager(conversationId, targetCwd);
			openedRuntime = await createAgentSessionRuntime(this.makeRuntimeFactory(openedTerminals, conversationId), {
				cwd: targetCwd,
				agentDir: this.agentDir,
				sessionManager,
			});

			// Only displace the old active conversation after the replacement runtime
			// is known-good. This keeps a failed history open entirely non-destructive.
			const oldListed = this.conv.listed;
			const displaced = this.displaceActive();
			const openInProject =
				[...this.convs.values()].filter((c) => c.cwd === targetCwd).length + 1 - (displaced?.cwd === targetCwd ? 1 : 0);
			if (openInProject > MAX_OPEN_CONVERSATIONS) {
				// displaceActive() may have promoted a streaming conversation into the
				// running list. Roll that presentation-only mutation back because no
				// switch will take place.
				this.conv.listed = oldListed;
				openedTerminals.killAll();
				await openedRuntime.dispose();
				openedRuntime = null;
				openedTerminals = null;
				this.emit({
					type: "notice",
					level: "warning",
					text: `This project already has the max open conversations (${MAX_OPEN_CONVERSATIONS}). Open one and leave it (without continuing) to remove it from the list.`,
				});
				return;
			}

			const conv = this.makeConversation(openedRuntime, conversationId, openedTerminals, cache);
			// Deliberately resumed — must not be dismissed when the user later
			// switches away without sending a new message.
			conv.promptedSinceActive = true;
			this.convs.set(conv.id, conv);
			this.activeId = conv.id;
			openedRuntime = null;
			openedTerminals = null;
			if (displaced) this.removeConversation(displaced.id);
			await this.bindSession();
			this.cwd = targetCwd;
			this.conv.lastActiveAt = Date.now();
			this.webUi.refresh();
			// Replay the resumed conversation's own statuses (role footer).
			this.pushActiveStatuses();
			this.emitConversations();
			this.pushTerminals();
			// The restored conversation has a fresh project-bound resource cache.
			void this.pushSlashCommands();
			// The conversation exists now — lift the prompt guard BEFORE the real
			// snapshot goes out, then the awaited restores (model chip may trail).
			this.bootingSwitches.delete(conversationId);
			bootingId = null;
			this.flushSnapshot(true);
			await this.restoreProjectDefaults(targetCwd);
			return;
		} catch (err) {
			openedTerminals?.killAll();
			if (openedRuntime) await openedRuntime.dispose().catch(() => {});
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch session: ${(err as Error).message}`,
			});
		} finally {
			if (bootingId !== null) this.bootingSwitches.delete(bootingId);
		}
		// Refused or failed after a preview: the client is looking at a
		// conversation that never came to be — hand it the active one back,
		// as a full snapshot (the preview invalidated the delta baseline).
		this.flushSnapshot(true);
	}

	/**
	 * Map a rendered user-message id (`u-<timestamp>-<seq>`, assigned in
	 * serialize.ts) back to its append-only session entry id. The seq handles
	 * two user messages sharing the same millisecond timestamp.
	 */
	private resolveUserMessageEntryId(messageId: string): string | null {
		const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
		if (!m) return null;
		const ts = Number(m[1]);
		const seq = m[2] ? Number(m[2]) : 1;
		let count = 0;
		// Resolve against the compaction-aware current leaf path — the same list
		// the UI renders (state.messages). Scanning the whole file (getEntries)
		// could match a summarized entry or one on a different branch.
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as unknown as { message?: AgentMessage }).message;
			if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return entry.id;
		}
		return null;
	}

	/**
	 * Edit a past user question and re-ask it: forks a NEW session file that
	 * keeps everything up to (but not including) that question, then sends the
	 * edited text there. The original thread is untouched and stays in the
	 * session list, so nothing is ever lost.
	 *
	 * Attachments (attachments) travel through the SAME pipeline as prompt()
	 * — the fork intentionally drops the original attachment asides because
	 * they live on the old branch past the fork point, so the browser re-sends
	 * the images it kept in the edit composer (original image blocks + any
	 * newly pasted/dropped ones). Text-only edits pass undefined.
	 */
	async editMessage(
		messageId: string,
		text: string,
		attachments?: Parameters<ClientSession["prompt"]>[1],
	): Promise<void> {
		if (this.quiesceBlocked()) return;
		const trimmed = text.trim();
		if (!trimmed) {
			this.emit({
				type: "notice",
				level: "warning",
				text: "Edited content is empty — cancelled",
			});
			this.flushSnapshot();
			return;
		}
		const entryId = this.resolveUserMessageEntryId(messageId);
		if (!entryId) {
			this.emit({
				type: "notice",
				level: "error",
				text: "Message to edit not found (may have been compacted or is on another branch)",
			});
			this.flushSnapshot();
			return;
		}
		try {
			// Preserve the model the user had selected — fork() seeds a new
			// branch with the ModelRuntime default model otherwise.
			const prevModel = this.session.agent.state.model ?? null;
			const result = await this.runtime.fork(entryId);
			if (result.cancelled) {
				this.emit({
					type: "notice",
					level: "info",
					text: "Edit-and-reask cancelled",
				});
				this.flushSnapshot();
				return;
			}
			await this.bindSession();
			// Restore the previously-selected model on the forked branch.
			if (prevModel && this.sharedModelRuntime) {
				try {
					await this.session.setModel(prevModel);
					const pm = prevModel as unknown as { provider: string; id: string };
					await this.restoreKeyForModel(`${pm.provider}/${pm.id}`, this.cwd);
				} catch {
					// model no longer resolvable — keep the default
				}
			}
			await this.prompt(trimmed, attachments);
			this.emit({
				type: "notice",
				level: "info",
				text: "Re-asked from that question (the original stays in the session list)",
			});
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Edit-and-reask failed: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Push the project list. A directory is a project when this client opened
	 * it explicitly (picker / set_cwd / launch cwd) OR it is a git repository
	 * root that has sessions — a repo you only ever ran the pi CLI in is still
	 * a project. A linked git worktree is never a project of its own: it is
	 * folded into its repository's MAIN checkout and listed in that project's
	 * `worktrees`, so chats run in `~/.pi/worktrees/<repo>/<branch>` sit under
	 * `<repo>` with a branch badge instead of forming a look-alike sibling.
	 * Anything else with sessions (a shell's default cwd like system32 or
	 * $HOME, the projectless chats dir, deleted workspaces) is not promoted;
	 * those listings are pushed right after so the sidebar can show them flat
	 * under "Recents".
	 */
	async pushProjects(): Promise<void> {
		try {
			const saved = this.stateStore.get(this.clientId);
			const removedKeys = new Set(this.stateStore.getRemovedProjects(this.clientId).map(cwdKey));
			const savedLastUsed = new Map<string, number>();
			for (const p of saved.projects) savedLastUsed.set(cwdKey(p.path), p.lastUsed);
			// Newest session per cwd across the whole store (one scan). Spellings
			// that differ only by case fold into one entry (the saved project's
			// spelling wins, else the first seen): on Windows they are the same
			// directory AND the same per-cwd session folder, so one listing under
			// the canonical spelling covers all of them.
			const canonical = new Map<string, string>();
			for (const p of saved.projects) canonical.set(cwdKey(p.path), p.path);
			canonical.set(cwdKey(this.cwd), this.cwd);
			const spelling = (path: string): string => {
				const key = cwdKey(path);
				let known = canonical.get(key);
				if (known === undefined) {
					known = path;
					canonical.set(key, known);
				}
				return known;
			};
			const latestByKey = new Map<string, number>();
			for (const s of await SessionManager.listAll(piSessionsRoot())) {
				if (!s.cwd) continue;
				const key = cwdKey(spelling(s.cwd));
				const t = s.modified.getTime();
				const prev = latestByKey.get(key);
				if (prev === undefined || t > prev) latestByKey.set(key, t);
			}
			this.canonicalCwd = canonical;

			// Group candidates by repository. A repo root (main or linked
			// checkout) resolves to its `git worktree list`; the first entry is
			// the main checkout and becomes the project.
			interface Group {
				path: string;
				lastUsed: number;
				worktrees: GitWorktree[] | null;
			}
			const groups = new Map<string, Group>();
			const bump = (g: Group, t: number) => {
				if (t > g.lastUsed) g.lastUsed = t;
			};
			const candidates = new Set<string>([...savedLastUsed.keys(), ...latestByKey.keys()]);
			for (const key of candidates) {
				const path = canonical.get(key) ?? key;
				if (path === this.projectlessCwd) continue;
				const t = Math.max(savedLastUsed.get(key) ?? 0, latestByKey.get(key) ?? 0);
				if (isRepoRoot(path)) {
					const list = await this.repoWorktrees(path);
					const main = list.length > 0 ? spelling(list[0].path) : path;
					const mainKey = cwdKey(main);
					let g = groups.get(mainKey);
					if (!g) {
						g = { path: main, lastUsed: 0, worktrees: list.length > 0 ? list : null };
						groups.set(mainKey, g);
					}
					bump(g, t);
				} else if (savedLastUsed.has(key)) {
					let g = groups.get(key);
					if (!g) {
						g = { path, lastUsed: 0, worktrees: null };
						groups.set(key, g);
					}
					bump(g, t);
				}
			}

			// Only keep directories that still exist — a deleted/unmounted workspace
			// is useless in the picker. Tombstoned entries (explicitly removed by
			// the user) stay hidden even though session files still mention them.
			const projects: ProjectSummary[] = [...groups.values()]
				.filter((g) => !removedKeys.has(cwdKey(g.path)) && existsSync(g.path))
				.map((g) => {
					const worktrees = g.worktrees
						?.filter((w) => existsSync(w.path))
						.map((w, i) => ({
							path: spelling(w.path),
							branch: w.branch,
							head: w.head.slice(0, 8),
							isMain: i === 0,
							locked: w.locked,
							managed: isManagedWorktree(w.path),
						}));
					return worktrees ? { path: g.path, lastUsed: g.lastUsed, worktrees } : { path: g.path, lastUsed: g.lastUsed };
				})
				.sort((a, b) => b.lastUsed - a.lastUsed)
				.slice(0, 20);
			this.emit({ type: "projects", projects });

			// Detached chats: every other cwd that has sessions, most recently
			// touched first, capped so a long CLI history can't flood the panel.
			const known = new Set<string>();
			for (const p of projects) {
				known.add(cwdKey(p.path));
				for (const w of p.worktrees ?? []) known.add(cwdKey(w.path));
			}
			const detached = [...latestByKey.entries()]
				.filter(([key]) => !known.has(key) && !removedKeys.has(key))
				.sort((a, b) => b[1] - a[1])
				.slice(0, ClientSession.RECENT_CWD_CAP)
				.map(([key]) => canonical.get(key) ?? key);
			if (!detached.includes(this.projectlessCwd)) detached.push(this.projectlessCwd);
			for (const cwd of detached) await this.refreshSessions(cwd);
		} catch {
			this.emit({ type: "projects", projects: [] });
		}
	}

	/** List a workspace directory (relative to the configured cwd). */
	async listFiles(relPath?: string): Promise<void> {
		return this.files.listFiles(relPath);
	}

	/** 全局搜索：递归文件名匹配（结果经 search_files_result 回推，reqId 匹配）。 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		return this.files.searchFiles(query, reqId);
	}

	/** 全局搜索：在当前工作区的会话转录全文里做大小写不敏感匹配 ——
	 *  不止首条消息，而是每一段 user 与 assistant 文本（AI 输出也在内）。
	 *  结果经 session_search_results 回推（reqId 匹配）；复用 loadSessionInfos()
	 *  缓存，避免每个按键都重新解析全部转录文件。 */
	async searchSessions(query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.emit({ type: "session_search_results", reqId, query, ok: true, results: [] });
			return;
		}
		try {
			const infos = await this.loadSessionInfos();
			const results = infos
				.filter((s) => sessionMatchesSearch(q, s))
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 50)
				.map((s) => {
					const base: SessionSummary = {
						path: s.path,
						name: s.name,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						modified: s.modified.getTime(),
						source: "web",
					};
					// 命中会话里再定位具体消息（供点击跳转）；仅元数据命中则无锚点
					return { ...base, anchors: collectSessionAnchors(s.path, q) };
				});
			this.emit({ type: "session_search_results", reqId, query, ok: true, results });
		} catch {
			this.emit({ type: "session_search_results", reqId, query, ok: false, results: [] });
		}
	}

	/** SCM 只读查询（结构化 JSON，reqId 匹配）。 */
	async scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		arg?: { path?: string; hash?: string },
	): Promise<void> {
		return this.files.scmQuery(kind, reqId, arg);
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		return this.files.readFile(relPath);
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		return this.files.writeFile(relPath, text);
	}

	async uploadFile(relDir: string, name: string, data: string): Promise<void> {
		return this.files.uploadFile(relDir, name, data);
	}

	async makeDir(relPath: string): Promise<void> {
		return this.files.makeDir(relPath);
	}

	async cycleModel(): Promise<void> {
		try {
			const result = await this.session.cycleModel();
			if (result?.model) {
				const mid = `${result.model.provider}/${result.model.id}`;
				await this.restoreKeyForModel(mid, this.cwd);
				// Remember per-project like setModel — cycling is also a model switch.
				this.rememberProjectModel(mid);
			}
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		return this.files.completePath(input);
	}

	/**
	 * Resolve + validate a workspace target typed / clicked by the user. Returns
	 * the absolute directory, or null after emitting the guidance notice for
	 * the virtual machine root. Throws (caller reports) when the path is not a
	 * directory. Shared by set_cwd and new_chat(cwd) so both apply the same
	 * MACHINE_ROOT / bare-drive rules.
	 */
	private async resolveWorkspaceTarget(newCwd: string): Promise<string | null> {
		const fs = await import("node:fs/promises");
		const trimmed = newCwd.trim();
		if (trimmed === MACHINE_ROOT) {
			// 机器根是虚拟层（盘符列表），不能作工作目录——指引用户选具体目录。
			this.emit({
				type: "notice",
				level: "warning",
				text: "Pick a concrete directory as the workspace (This PC itself is not a directory)",
			});
			return null;
		}
		// Windows 裸盘符（"C:"）：resolve 会按该盘当前目录解析，必须显式指到盘根；
		// 仅 win32 生效——posix 下 "C:" 仍是普通相对路径，避免误伤同名目录。
		const abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
		const st = await fs.stat(abs);
		if (!st.isDirectory()) {
			throw new Error("路径不是目录");
		}
		return abs;
	}

	/**
	 * Everything a project switch does once a conversation of `abs` is ACTIVE
	 * (set_cwd, new_chat(cwd) into a project with no open chat, and the
	 * cross-project branch of switch_conversation). Synchronous: the snapshot
	 * the caller flushes right after this is the one the user is waiting for;
	 * the awaited per-project restores follow it (restoreProjectDefaults).
	 *
	 * `asProject` false only records the restore target (see
	 * ClientStateStore.remember): a chat whose cwd is a random shell directory
	 * must not become a sidebar project.
	 */
	private followWorkspace(abs: string, asProject: boolean): void {
		this.cwd = abs;
		// 工作区跟随型插件（编辑器文件树等）同步切根。
		try {
			this.onCwdChanged?.(abs);
		} catch {
			/* 钩子异常不影响主流程 */
		}
		// Remember the new workspace (restore target + recent-project entry).
		this.stateStore.remember(this.clientId, abs, asProject);
		void this.pushProjects();
		this.webUi.refresh();
		// Project switch also switches the active conversation — replay its
		// own statuses so the role footer follows (issue #116).
		this.pushActiveStatuses();
		this.emitConversations();
		this.pushTerminals();
		// Skills / prompt templates are project-bound — refresh the catalog.
		void this.pushSlashCommands();
		void this.refreshSessions();
		void this.listFiles(undefined);
		// Commands are per-project (.pi/commands.json in the current cwd).
		void this.listCommands();
	}

	/**
	 * Make a freshly booted runtime the active conversation of a project the
	 * client has no open chat in yet (set_cwd resumes the project's most
	 * recent session, new_chat(cwd) creates a blank one — same bookkeeping).
	 * `displaced` is the outgoing active conversation when displaceActive()
	 * said to drop it; removal happens only now that the replacement exists.
	 */
	private async activateFreshConversation(conv: Conversation, displaced: Conversation | null): Promise<void> {
		this.convs.set(conv.id, conv);
		this.activeId = conv.id;
		if (displaced) this.removeConversation(displaced.id);
		for (const d of conv.runtime.diagnostics) {
			if (d.type !== "info") {
				this.emit({ type: "notice", level: d.type, text: d.message });
			}
		}
		await this.bindSession();
		conv.promptedSinceActive = false;
		conv.lastActiveAt = Date.now();
	}

	async setCwd(newCwd: string): Promise<void> {
		try {
			this.files.unwatchGit(); // stale repo's watcher must not fire across projects
			const abs = await this.resolveWorkspaceTarget(newCwd);
			if (abs === null) return;
			if (abs === this.cwd) {
				this.stateStore.remember(this.clientId, abs);
				void this.pushProjects();
				this.flushSnapshot();
				return;
			}

			// The outgoing conversation is left behind — apply the running-list
			// lifecycle (removal is deferred until the active conversation is
			// safely switched away).
			const displaced = this.displaceActive();

			// Prefer the target project's own most recently active conversation;
			// only create a fresh one (resuming its most recent session) when the
			// project has none open yet.
			let target: Conversation | undefined;
			for (const c of this.convs.values()) {
				if (c.cwd === abs && (!target || c.lastActiveAt > target.lastActiveAt)) {
					target = c;
				}
			}

			if (target) {
				this.activeId = target.id;
				if (displaced) this.removeConversation(displaced.id);
				target.promptedSinceActive = false;
				target.lastActiveAt = Date.now();
			} else {
				// First visit to this project: resume its most recent session.
				const conversationId = this.nextConversationId();
				const terminals = this.makeTerminalManager(conversationId, abs);
				const newRuntime = await createAgentSessionRuntime(this.makeRuntimeFactory(terminals, conversationId), {
					cwd: abs,
					agentDir: this.agentDir,
					sessionManager: SessionManager.continueRecent(abs),
				});
				await this.activateFreshConversation(this.makeConversation(newRuntime, conversationId, terminals), displaced);
			}

			this.followWorkspace(abs, true);
			// Snapshot first, then the awaited restores (model chip may trail).
			this.flushSnapshot();
			await this.restoreProjectDefaults(abs);
			return;
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch directory: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Strip the "(New)" freshness marker some catalogs append to display names
	 *  (pi.dev data, e.g. "DeepSeek V4 Pro (New)") — display-only; the model id
	 *  is untouched so switching still uses the exact official id. */
	private cleanModelDisplayName(name: string): string {
		return name.replace(/\s*\(new\)$/i, "").trim();
	}

	/** List models that have valid authentication configured. */
	async listModels(): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			// Reconcile built-in provider catalogs with the official pi.dev
			// endpoint before listing: within the SDK's 4h freshness window this
			// is a fast 304; past it the newest catalog is downloaded WHOLESALE
			// (patch-remote-catalog.ts) — no union merge, no stale built-in
			// leftovers, no "新增 N 个模型" noise. Network failure falls back to
			// the cached catalog silently.
			await mr.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) }).catch(() => {
				// list must never fail because the catalog sync did
			});
			const available = await mr.getAvailable();
			const models = available.map((m) => ({
				id: `${m.provider}/${m.id}`,
				name: this.cleanModelDisplayName(m.name),
				provider: m.provider,
				reasoning: m.reasoning,
				vision: m.input?.includes("image") ?? false,
			}));
			this.emit({ type: "models", models });
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to fetch model list: ${(err as Error).message}`,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Goal / review
	// ---------------------------------------------------------------------------

	/** Switch to a specific model by "provider/id" (e.g. "anthropic/claude-sonnet-5"). */
	async setModel(modelId: string): Promise<void> {
		try {
			const mr = this.runtime.services.modelRuntime;
			const slash = modelId.indexOf("/");
			if (slash <= 0 || slash === modelId.length - 1) {
				throw new Error(`无效的模型 ID：${modelId}`);
			}
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			const model = mr.getModel(provider, id);
			if (!model) throw new Error(`模型不存在：${modelId}`);
			await this.session.setModel(model);
			await this.restoreKeyForModel(modelId, this.cwd);
			// Immediately remember the model + the key it uses for the current
			// project (not only after a turn). This is what makes project switching
			// restore both the model and the provider key.
			this.rememberProjectModel(modelId);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch model: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Set the thinking level for future turns. */
	setThinking(level: string): void {
		try {
			this.session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	cycleThinking(): void {
		try {
			this.session.cycleThinkingLevel();
		} catch (err) {
			this.emit({
				type: "notice",
				level: "error",
				text: `Failed to switch thinking level: ${(err as Error).message}`,
			});
		}
		this.flushSnapshot();
	}

	/** Push the user command list (.pi/commands.json) to the client. */
	async listCommands(): Promise<void> {
		const { commands, path, warning } = await loadCommands(this.cwd);
		if (warning) {
			this.emit({ type: "notice", level: "warning", text: warning });
		}
		this.emit({ type: "commands", commands, path });
	}

	/** Persist the user command list (.pi/commands.json). */
	async saveCommands(commands: CommandDef[]): Promise<void> {
		const { path, error } = await saveCommandsFile(this.cwd, commands);
		if (error) {
			this.emit({ type: "notice", level: "error", text: error });
			return;
		}
		this.emit({ type: "commands", commands, path });
		this.emit({ type: "notice", level: "info", text: `Command saved: ${path}` });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const conv of this.convs.values()) conv.terminals.killAll();
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = null;
		}
		if (this.sessionsTimer) {
			clearTimeout(this.sessionsTimer);
			this.sessionsTimer = null;
		}
		if (this.widgetsTimer) {
			clearInterval(this.widgetsTimer);
			this.widgetsTimer = null;
		}
		if (this.stallTimer) {
			clearInterval(this.stallTimer);
			this.stallTimer = null;
		}
		for (const timer of this.workerPushTimers.values()) clearTimeout(timer);
		this.workerPushTimers.clear();
		this.files.unwatchDir();
		this.files.unwatchGit();
		this.webUi.dispose();
		// 关闭所有挂起的用户提问（dispose 时以「取消」解析，避免模型挂死）。
		this.cancelPendingQuestions();
		this.bg.stop();
		for (const conv of this.convs.values()) {
			this.clearAllToolWatchdogs(conv);
			conv.notificationLifecycle.reset();
			conv.unsubscribe?.();
			try {
				await conv.runtime.dispose();
			} catch {
				// best effort
			}
		}
	}
}

export class AgentService {
	private clients = new Map<string, ClientSession>();
	/** Quiesce (draining) state — the service refuses NEW work (prompts, forks,
	 *  session resumes, new clients) so a deploy/upgrade/backup can stop cleanly
	 *  once existing runs finish. Controlled via the local control socket:
	 *  `pi-web-ui server quiesce|unquiesce`. */
	private quiesced = false;
	private quiescedAt = 0;
	/** Attached browser sockets (reported by index.ts on open/close) — the
	 *  control socket reports real sockets, not cached client-session objects. */
	private socketCount = 0;
	private pending = new Map<string, Promise<ClientSession>>();
	private stateStore: ClientStateStore;
	/** Set by index.ts: called when /pi-web-ui:quit is invoked. */
	onQuit: (() => boolean) | undefined = undefined;
	/** 任意客户端成功切换工作区后触发（新绝对路径）。index.ts 接到
	 *  PluginManager.notifyCwd，让插件宿主的 host.cwd 实时跟随当前项目。 */
	onClientCwdChanged: ((cwd: string) => void) | undefined = undefined;

	constructor(
		private cwd: string,
		stateFile: string,
	) {
		this.stateStore = new ClientStateStore(stateFile);
	}

	/** Get or create the session for a client, racing attach calls safely. */
	/** True while the service is draining — new work is refused. */
	isQuiesced(): boolean {
		return this.quiesced;
	}

	/** Enter quiesce: stop admitting new work. Existing runs keep going. */
	quiesce(): void {
		this.quiesced = true;
		this.quiescedAt = Date.now();
	}

	/** Leave quiesce: admit new work again. */
	unquiesce(): void {
		this.quiesced = false;
		this.quiescedAt = 0;
	}

	/** Snapshot for the control socket / status command. */
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number } {
		return this.quiesced ? { quiesced: true, quiescedSince: this.quiescedAt } : { quiesced: false };
	}

	/** Aggregate across every client session: conversations with in-flight runs. */
	activeConversations(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.activeConversations();
		return n;
	}

	/** Aggregate across every client session: messages queued in the SDK. */
	pendingMessages(): number {
		let n = 0;
		for (const cs of this.clients.values()) n += cs.pendingMessages();
		return n;
	}

	/** index.ts calls this when a browser socket opens/closes. */
	noteSocketOpen(): void {
		this.socketCount += 1;
	}
	noteSocketClose(): void {
		this.socketCount = Math.max(0, this.socketCount - 1);
	}

	/** Full status for the control socket / `server status` command. */
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		/** 托管本实例的平台服务（null = 前台/dev/Docker）——CLI 的
		 *  `server status` 据此显示启动方式，见 launch-origin.ts。 */
		service: UiServiceInfo | null;
	} {
		return {
			pid: process.pid,
			version: VERSION,
			cwd: this.cwd,
			...this.quiesceInfo(),
			connectedClients: this.socketCount,
			activeConversations: this.activeConversations(),
			pendingMessages: this.pendingMessages(),
			service: toServiceInfo(launchOrigin()),
		};
	}

	/** Get or create the session for a client, racing attach calls safely. */
	async attach(clientId: string, send: (msg: ServerMessage) => void): Promise<ClientSession> {
		let cs = this.clients.get(clientId);
		if (!cs) {
			const inflight = this.pending.get(clientId);
			if (inflight) {
				cs = await inflight;
			} else {
				// Restore this client's last-used workspace when it still exists;
				// Admission gate: while quiesced, only clients with an EXISTING
				// session may attach (they can watch their runs drain); brand-new
				// clients are refused — index.ts closes their socket (4403) and the
				// browser reconnect loop retries after admission reopens.
				if (this.quiesced) {
					throw new QuiesceRejectedError("新连接被拒绝，请等服务器恢复后重试");
				}
				// otherwise fall back to the server's configured default cwd.
				let cwd = this.cwd;
				const saved = this.stateStore.get(clientId);
				if (saved.lastCwd && saved.lastCwd !== this.cwd) {
					try {
						if (statSync(saved.lastCwd).isDirectory()) cwd = saved.lastCwd;
					} catch {
						// gone (unmounted drive / deleted) — fall back to the default
					}
				}
				// Sessions use the SDK default per-project dir — no per-client dir.
				const creating = ClientSession.create(clientId, cwd, this.stateStore).finally(() => {
					this.pending.delete(clientId);
				});
				this.pending.set(clientId, creating);
				cs = await creating;
				this.clients.set(clientId, cs);
				// Make sure the restored/default workspace appears in the project list.
				this.stateStore.remember(clientId, cwd);
			}
		}
		// First attach after a restart: report runs that were interrupted when
		// the previous process shut down (consumed once, then cleared). Queue
		// BEFORE attachSink so the notice rides the initial pending-notice flush.
		cs.notifyInterrupted(this.stateStore.takeInterrupted(clientId));
		cs.attachSink(send);
		// Forward hooks (set once by index.ts) to every session.
		cs.onQuit = this.onQuit;
		cs.isQuiesced = () => this.quiesced;
		return cs;
	}

	/** Remove a socket from a client's broadcast set (called on socket close). */
	detach(clientId: string, send: (msg: ServerMessage) => void): void {
		this.clients.get(clientId)?.detachSink(send);
	}

	get(clientId: string): ClientSession | undefined {
		return this.clients.get(clientId);
	}

	async disposeAll(): Promise<void> {
		// Record still-streaming conversations BEFORE tearing anything down, so
		// the next attach can tell the user what was lost (SIGTERM / update).
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [clientId, cs] of [...this.clients]) {
			try {
				const running = cs.streamingSummaries();
				if (running.length > 0) {
					this.stateStore.saveInterrupted(
						clientId,
						running.map((r) => ({ ...r, at: Date.now() })),
					);
				}
			} catch {
				// best effort — never block shutdown on bookkeeping
			}
		}
		const all = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(all.map((cs) => cs.dispose()));
	}
}
