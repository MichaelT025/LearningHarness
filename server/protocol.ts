/**
 * Wire protocol between the browser client and the pi-web-ui server.
 * Pure JSON over WebSocket. The web frontend mirrors these types in
 * web/src/types.ts (kept in sync by hand — types only, no shared runtime code).
 */

// ---------------------------------------------------------------------------
// Serialized messages (server -> client snapshot)
// ---------------------------------------------------------------------------

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

/** Live bash execution (the `!` command / bashExecution transcript message). */
export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	UiTextBlock | UiThinkingBlock | UiToolCallBlock | UiImageBlock | UiBashBlock | { type: string; [k: string]: unknown };

export interface UiMessage {
	/** Stable-ish id for React keys: u-<ts>-<seq> / a-<ts>-<seq> / t-<toolCallId>. */
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Present on toolResult messages; links to the assistant message's toolCall block. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Extension-injected custom messages. */
	customType?: string;
	/** Extension-provided metadata (e.g. attachment file name/path). */
	details?: unknown;
	/** Present on compactionSummary messages: context size (tokens) before
	 *  compaction — the card header renders "compacted from N tokens" like
	 *  the pi CLI. Absent on older snapshots. */
	tokensBefore?: number;
}

/** One pi-todo task (extensions/pi-todo/tool/types.ts: Task). */
export interface TodoTask {
	id: number;
	subject: string;
	description?: string;
	/** Present-continuous label shown while in_progress (e.g. "writing tests"). */
	activeForm?: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TodosState {
	tasks: TodoTask[];
	nextId: number;
	/** Ids created or changed since the current/last agent run started. */
	runIds: number[];
	/** Whether an agent run is in flight (strip shows live progress). */
	running: boolean;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

/** Platform service manager supervising this instance: someone restarts the
 *  process after it exits. Detected at boot by server/launch-origin.ts. */
export type ServiceSupervisor = "launchd" | "systemd" | "windows-watchdog";

/** How this instance was launched, when a supervisor manages it.
 *
 *  `pi-web-ui server start|install` registers a service (launchd / systemd /
 *  Windows watchdog launcher); the browser uses this to offer "restart
 *  service" in the UPDATE panel — meaningless for a foreground `pi-web-ui`
 *  or `npm run dev` instance, whose process would simply be gone. */
export interface UiServiceInfo {
	/** Service name (`server install --name`, default "pi-web-ui"). */
	name: string;
	supervisor: ServiceSupervisor;
}

export interface UiState {
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	/** Id of the ACTIVE conversation (see `conversations` message). */
	conversationId: string;
	/** Monotonic snapshot revision — increments on every snapshot/snapshot_delta
	 *  emission. snapshot_delta.baseRev must equal the client's current rev;
	 *  a mismatch means the client missed an update and must get_state resync. */
	rev: number;
	messages: UiMessage[];
	/**
	 * Transcript-first preview: this snapshot was built from the session file
	 * alone (switch_session) while the conversation's runtime is still
	 * starting, so `messages` are final but model/thinking/tools/commands are
	 * placeholders and prompts are not accepted yet. The real snapshot for the
	 * same conversationId (without this flag) replaces it; a failed boot is
	 * followed by a snapshot of the previous conversation plus a notice.
	 */
	booting?: boolean;
	/**
	 * Live partial assistant message while a run is streaming. The SDK keeps the
	 * in-progress message in agent.state.streamingMessage — it only enters
	 * `messages` once the turn finishes (message_end). Null when idle.
	 */
	streamingMessage: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	/**
	 * Thinking levels the CURRENT model actually supports (SDK clamps any
	 * request outside this set). The UI must only offer these — selecting an
	 * unsupported level silently snaps to a nearby one, which reads as "cannot
	 * change the level". Empty/absent → fall back to the full list.
	 */
	availableThinkingLevels: string[];
	/** Queued prompt TEXTS per conversation. steering = 插队（当前回合结算后
	 *  立即注入），followUp = 排队（整个 run 结束后才发送）。UI renders them
	 *  as pending user bubbles in the real message list. */
	queue: { steering: string[]; followUp: string[] };
	errorMessage?: string;
	/**
	 * Transient LLM auto-retry state — set while the SDK backs off and retries
	 *  a failed API call (agent_end willRetry → auto_retry_start → auto_retry_end).
	 *  While present the trailing stopReason=error assistant message is withheld
	 *  from `messages` (it only turns red permanently once retries are exhausted),
	 *  and the UI shows a calm "retrying…" hint instead of a flashing red error.
	 *  Absent/null when idle or on final failure.
	 */
	retry?: {
		/** 1-based attempt about to run (0 = announced by agent_end willRetry, details follow). */
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
	} | null;
	/**
	 * Context compaction in progress (compaction_start arrived, compaction_end
	 *  not yet). While present the UI shows a persistent "compacting…"
	 *  progress banner with elapsed time (a toast would auto-dismiss while
	 *  the summarization LLM call is still running). Absent/null when idle.
	 */
	compaction?: {
		/** Why compaction started: manual (/compact), threshold or overflow. */
		reason: string;
		/** Server-side start timestamp (ms) — drives the elapsed timer. */
		startedAt: number;
	} | null;
	/**
	 * 待用户回答的模型提问（ask_user_question）——对话框的服务端事实源。
	 *  `question_pending` 只在提问发生的那一刻推给「当时在线」的连接；刷新页面 /
	 *  WS 重连 / 新标签页接入后客户端拿不到那条历史消息，本字段让快照把对话框
	 *  恢复出来（见 web/src/use-chat.ts 的 syncPendingQuestion）。
	 *  只携带当前对话的提问（切回原对话会重推快照，对话框随之回来）。
	 *  null / 缺省 = 当前对话没有待答提问。
	 */
	pendingQuestion?: UiPendingQuestion | null;
	/** Delegated workers of this conversation (PiAstra `delegate` tool), live
	 *  and saved, in start order. Empty when the extension is not loaded. */
	workers: UiWorker[];
	tools: string[];
	/** Monotonic snapshot sequence — clients can use it to drop stale snapshots. */
	version: number;
	/**
	 * Whether the pi agent has at least one usable model. The SDK resolves
	 * models.json together with auth.json, environment credentials, OAuth, and
	 * runtime API-key overrides. False → offer the one-time setup flow.
	 */
	piConfigured: boolean;
	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). True → the setup modal skips the install step and offers the
	 * API key form directly; false → offer auto-install first.
	 */
	piAgentInstalled: boolean;
	/** Live session stats for the footer status bar. */
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
			/** true = 压缩后 SDK 暂报 null（下轮模型响应前不可信），此处用
			 *  compaction_end 的 estimatedTokensAfter 回填的约数，UI 加 `~` 标识。 */
			estimated?: boolean;
		};
	};
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** A user-defined command shown in the terminal command list (.pi/commands.json). */
export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

/** Metadata for a persistent PTY owned by one conversation. */
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	running: boolean;
	exitCode: number | null;
	/** Command that started this terminal, when it came from the command list. */
	command?: CommandDef;
	/** true = 终端接管 bash 的持久终端（'ai-bash'）：不计入终端数量上限，
	 *  前端把它单独归到「AI bash」折叠分组里。缺省 false = 用户终端。 */
	agentBash?: boolean;
}

/** A slash command available in the chat input (the web counterpart of the
 *  pi CLI's "/" command menu). Names carry no leading slash. */
export interface SlashCommandInfo {
	/** Invokable command name without the leading slash (e.g. "new",
	 *  "skill:review", "templatename"). Extension collisions with builtin
	 *  names are suffixed by the SDK ("new:2"), like the CLI. */
	name: string;
	description?: string;
	/** Argument placeholder shown in the picker (e.g. "<路径>", "[说明]"). */
	argumentHint?: string;
	/** Where the command comes from: web-native builtin / SDK extension /
	 *  prompt template / skill / UI plugin（registerCommand）。 */
	source: "builtin" | "extension" | "prompt" | "skill";
}

/** Attachment spec shared by "prompt" and "edit_message" client messages:
 *  workspace-path attachments (inline/reference/lines), raw pasted/dropped
 *  images (imageData) and raw uploaded files (fileData). */
export interface PromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines";
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/**
	 * Raw image data (base64, no data: prefix) for images pasted, dropped or
	 * uploaded directly in the browser — no workspace path involved. When
	 * present the server sends it to the model as image content and ignores
	 * path/mode.
	 */
	imageData?: string;
	/**
	 * Raw uploaded file bytes (base64, no data: prefix) for files dropped/
	 * uploaded directly in the browser — no workspace path involved. The
	 * server persists them under the data dir and attaches as a path
	 * reference (or inlines small text files).
	 */
	fileData?: string;
	/**
	 * Absolute path of a previously-UPLOADED file (fileData) that was
	 * persisted under the data dir's uploads/ folder. When the browser
	 * restores an uploaded file while editing & re-asking a question it
	 * re-sends the server-generated upload path instead of the original
	 * base64 — the server re-reads the bytes from disk (no base64
	 * round-trip / snapshot bloat). Mutually exclusive with imageData /
	 * fileData / path.
	 */
	uploadPath?: string;
	mimeType?: string;
	/** Display name for the attachment card (filename, or "粘贴图片.png"). */
	name?: string;
	/** Decoded byte size, for the card's size hint. */
	size?: number;
}

export type ClientMessage =
	| { type: "hello"; clientId: string; protocolVersion?: number }
	/** Re-request the slash-command catalog (also pushed on attach / cwd change). */
	| { type: "get_commands" }
	| {
			type: "prompt";
			text: string;
			/**
			 * While the agent is streaming: queue this prompt and deliver it after
			 * the WHOLE run finishes (followUp) instead of steering (injecting it
			 * right after the current turn settles, skipping remaining tool calls).
			 * The 补充 (supplement) button sends queue=true; plain Enter keeps the
			 * steer semantic.
			 */
			queue?: boolean;
			attachments?: PromptAttachment[];
	  }
	// -- queued prompt management ---------------------------------------------
	/** Remove ONE queued prompt (steer = 插队, followUp = 排队) by text — the
	 *  ✕ delete button on a pending user bubble. Removes the FIRST occurrence of
	 *  `text` in the matching queue and pushes a fresh snapshot so the bubble
	 *  disappears immediately. */
	| {
			type: "queue_remove";
			kind: "steer" | "followUp";
			text: string;
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			title?: string;
			cwd: string;
			cols: number;
			rows: number;
			/** Optional because old UI clients target the active conversation. */
			conversationId?: string;
	  }
	| { type: "terminal_input"; terminalId: string; data: string; conversationId?: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number; conversationId?: string }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string }
	| { type: "rename_terminal"; terminalId: string; title: string; conversationId?: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	// Re-discover extensions/skills/prompt templates from disk after an
	// external change (e.g. `pi remove npm:<pkg>` finished in the terminal).
	// Streaming-safe: deferred to agent_end while a run is in flight.
	| { type: "extensions_reload" }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	/** Kill only the running bash command(s) — the agent run itself continues. */
	| { type: "abort_bash" }
	/** Manually retry the last failed model call after the auto-retry budget
	 *  (settings retryMaxAttempts) ran out: the turn ended with a red error
	 *  and is idle. Server re-triggers one LLM turn without adding a new user
	 *  message; refused while streaming. */
	| { type: "retry_last" }
	// -- background tasks (AI-started servers) ------------------------------
	/** Kill ONE background server the agent started (by listening port). */
	| { type: "kill_background_server"; port?: number }
	/** Kill EVERY background server the agent started (frees all ports). */
	| { type: "kill_background_servers" }
	/** Re-push the current background-server list (the server also refreshes it
	 *  on its own and prunes entries whose process exited). */
	| { type: "list_bg_servers" }
	/** Global-search recursive filename match across the active workspace.
	 *  Server-side bounded walk; reqId echoes back in search_files_result. */
	| { type: "search_files"; reqId: number; query: string }
	/** Global-search conversation-content match across this workspace's
	 *  persisted session transcripts — every user AND assistant message,
	 *  AI output included. reqId echoes back in session_search_results. */
	| { type: "search_sessions"; reqId: number; query: string }
	// -- source-control panel (read-only git queries, server-side execFile) --
	/** SCM refresh payload: status + branches + numstat (history loads
	 *  lazily via scm_history so big repos don't pay for it every refresh). */
	| { type: "scm_status"; reqId: number }
	/** Commit graph for the history tab (lazy-loaded). */
	| { type: "scm_history"; reqId: number }
	/** Staged + worktree diffs for one file. */
	| { type: "scm_filediff"; reqId: number; path: string }
	/** Full patch of one commit. */
	| { type: "scm_commit"; reqId: number; hash: string }
	| { type: "new_chat"; cwd?: string | null }
	/** Edit a past user question and re-ask it (forks a new session at that point). */
	| {
			type: "edit_message";
			messageId: string;
			text: string;
			/**
			 * Attachments to send along with the re-asked question. The editor
			 * pre-fills it with the original message's attachments (images →
			 * imageData, uploaded files → uploadPath, workspace paths →
			 * path+mode; fork drops the persisted attachment asides — they live
			 * on the old branch, past the fork point) and accepts newly
			 * pasted/dropped images and files.
			 */
			attachments?: PromptAttachment[];
	  }
	| { type: "cycle_model" }
	| { type: "cycle_thinking" }
	| { type: "get_state" }
	/** List persisted session transcripts. `cwd` scopes the query to one
	 *  project directory (the server maps it to that project's session store);
	 *  omitted = the ACTIVE conversation's cwd (backward-compatible). Scoping by
	 *  cwd lets the left panel load another project's history on expand WITHOUT
	 *  switching the active conversation. */
	| { type: "list_sessions"; cwd?: string }
	| { type: "switch_session"; path: string }
	| { type: "switch_conversation"; id: string }
	| { type: "list_projects" }
	/** Open the host OS folder picker; cancellation leaves the project unchanged. */
	| { type: "pick_project_folder" }
	| { type: "list_files"; path?: string }
	/** 列目录：path 省略 = 工作区根；也接受工作区外绝对路径（Windows "C:/…"、
	 *  posix "/…"）与机器根 "@root"（盘符列表，见 files-service.ts MACHINE_ROOT）。
	 *  机器浏览时返回的 entry.path 为绝对 wire 路径，可直接再用于列目录/预览/附件。 */
	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	| { type: "read_file"; path: string }
	/** Save text edited in the file preview panel. */
	| { type: "write_file"; path: string; text: string }
	/**
	 * Upload one file INTO a workspace directory (file manager right-click
	 * context menu — blank area or a folder entry). data = raw base64 with
	 * NO data: prefix; name is basename-sanitized server-side. The server
	 * answers with a notice (+ file_changed so the listing refreshes).
	 */
	| { type: "upload_file"; dirPath: string; name: string; data: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	/** Create a folder for the cwd picker (absolute, ~- or session-relative).
	 *  The server answers with a notice (success/failure) — the picker
	 *  refreshes its own listing afterwards. */
	| { type: "make_dir"; path: string }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	/** Restart the supervised service (same effect as `pi-web-ui server restart`:
	 *  this process exits and its supervisor brings it back). The server refuses
	 *  when no supervisor manages this instance (foreground / dev / Docker). */
	| { type: "restart_service" }
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	/** Clear a built-in provider's stored key (auth.json entry + runtime
	 *  override) so it returns to the unconfigured state. Only meaningful for
	 *  keys whose auth status reports source "stored". */
	| { type: "clear_provider_api_key"; provider: string }
	// -- built-in provider multiple keys (one provider, several API keys) -----
	/** List every stored API key for each built-in provider (NICKNAMES only — raw
	 *  apiKey and masked fragments NEVER leave the server). Pushed on attach and
	 *  after any change. */
	| { type: "list_provider_keys" }
	/** Add a SECONDARY API key to a built-in provider's key list. `name` is the
	 *  only thing the frontend ever sees (auto-generated when blank); the key
	 *  value travels here ONCE and is stored server-side. The added key stays
	 *  INACTIVE so the current active key keeps routing; the user switches to it
	 *  by clicking a model under the key's group in the picker — or by name. When
	 *  the provider has no key yet, the added key becomes the active one. */
	| { type: "add_provider_key"; provider: string; apiKey: string; name?: string }
	/** Make a stored API key the ACTIVE one for a built-in provider by NAME
	 *  (syncs auth.json + runtime override + refreshes models). The server
	 *  resolves the stored key value from the name. */
	| { type: "activate_provider_key"; provider: string; keyName: string }
	/** Remove a stored API key from a built-in provider by NAME. If it was the
	 *  active key, the first remaining key becomes active (or the provider
	 *  returns to unconfigured when no key is left). */
	| { type: "remove_provider_key"; provider: string; keyName: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	/** Re-read models.json from disk into the model runtime and repush the
	 *  model list — for edits made outside the UI (hand edits, scripts).
	 *  Same refresh tail that save_model_config runs. */
	| { type: "reload_models_config" }
	/** Upsert one provider (api/baseUrl/apiKey + its models) into models.json. */
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	/** Remove a provider from models.json. */
	| { type: "delete_model_config"; providerId: string }
	/** List pi's built-in providers with their auth status (key-only config). */
	| { type: "list_providers" }
	/** Probe a custom provider's OpenAI-compatible /models endpoint and return
	 *  the advertised model ids. Runs SERVER-side (the baseUrl is often a
	 *  LAN/loopback host the browser can't reach cross-origin). reqId is echoed
	 *  back in fetch_models_result so the UI can match concurrent requests. */
	| {
			type: "fetch_models";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
			api?: string;
	  }
	/** Re-probe a SAVED provider's /models endpoint and merge the result into
	 *  its models.json entry. Credentials stay server-side (the browser never
	 *  sees apiKey/headers); reqId is echoed in refresh_provider_result. */
	| { type: "refresh_provider_models"; providerId: string; reqId: number }
	/** Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 *  editable custom-provider draft — the point is running a second API key
	 *  alongside the built-in one without overwriting it. Nothing is saved
	 *  until save_model_config; the draft comes back in clone_provider_result
	 *  with a fresh provider id and an EMPTY apiKey for the user to fill. */
	| { type: "clone_provider"; provider: string; reqId: number }
	// -- settings (system prompt / skills / extensions / presets) ------------
	/** Request the current settings state (also pushed automatically on attach). */
	| { type: "get_settings" }
	/** Apply a partial settings update: compose template / per-source overrides or
	 *  skill/extension toggles. Each change is persisted per client; prompt
	 *  template changes reload the runtime, while review changes affect the next review. */
	| {
			type: "set_settings";
			promptMode?: "append" | "replace";
			customSystemPrompt?: string;
			/** 组合模板文本（{{token}} 自由拼装，空 = 默认模板，见 prompt-composer）。 */
			promptTemplate?: string;
			/** 各来源 token 的独立覆盖（空 = 用自动内容）。 */
			promptOverrides?: Record<string, string>;
			disabledSkills?: string[];
			disabledExtensions?: string[];
			/** 统一 Agent 工具禁用名单（见 server/tool-manager.ts；live 生效无需 reload）。 */
			disabledAgentTools?: string[];
			/** Persistent-terminal tools on/off (default on). Off → terminal_* tools
			 *  are removed from the active tool set and the built-in usage guidance
			 *  disappears from the system prompt. */
			terminalToolsEnabled?: boolean;
			/** 终端接管 bash 开关 + 静默解阻阈值毫秒（0 = 一直等到命令结束）。 */
			terminalBash?: boolean;
			terminalBashIdleMs?: number;
			/** 问卷提问（ask_user_question）开关（默认开）。关 → 模型不再弹问卷。 */
			questionnaireEnabled?: boolean;
			/** 思考文本是否换行（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			thinkingWrap?: boolean;
			/** 工具调用是否默认展开（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			toolsWrap?: boolean;
			/** skill 全文注入名单（默认空 = 名录模式）。名单里的技能 {{skills}} 展开正文。 */
			skillsFullText?: string[];
			/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。即时生效，无需 reload。 */
			retryMaxAttempts?: number;
	  }
	/** Save the CURRENT settings as a named preset (overwrites if it exists). */
	| { type: "save_preset"; name: string }
	/** Answer a model ask_user_question dialog (id echoes
	 *  question_pending.id). `cancelled` (user ✗) rejects the pending ask. */
	| {
			type: "question_answer";
			id: string;
			answers: QuestionAnswer[];
			cancelled?: boolean;
	  }
	/** Replace the current settings with the named preset and apply it. */
	| { type: "apply_preset"; name: string }
	/** Remove the named preset. */
	| { type: "delete_preset"; name: string }
	/** Drop one workspace from this client's recent-project list (UI state
	 *  only — nothing on disk is touched). */
	| { type: "remove_project"; path: string }
	/** Check `branch` out as a linked worktree of the repository containing
	 *  `cwd` (any checkout of it; omitted = the active cwd) under
	 *  `~/.pi/worktrees/<repo>/<slug>`, then open a blank chat there — the
	 *  same fresh-session-in-the-worktree the CLI's `/worktree add` does. An
	 *  existing checkout of the branch is reused. `branch` omitted = a
	 *  generated name. Answered with worktree_result. */
	| { type: "worktree_add"; cwd?: string; branch?: string }
	/** Remove a linked worktree directory (its branch is kept). Refused while
	 *  an open conversation runs in it. Without `force`, a worktree with
	 *  uncommitted changes answers worktree_result{dirty:true} instead. */
	| { type: "worktree_remove"; path: string; force?: boolean }
	/** Permanently delete a persisted session transcript file (history list). */
	| { type: "delete_session"; path: string }
	/** Append a session_info name entry to a persisted session transcript (history rename). */
	| { type: "rename_session"; path: string; name: string }
	/** Rename a live conversation: retitle + persist a session_info entry so History matches. */
	| { type: "rename_conversation"; id: string; name: string }
	/** Dismiss a running conversation from the left-panel list (frees its runtime
	 *  but keeps the persisted transcript in history). Only non-streaming
	 *  conversations can be dismissed; streaming ones refuse with a notice.
	 *  force = abort a running conversation before dismissing it. The active
	 *  conversation may be dismissed too (the server switches away first). */
	| { type: "dismiss_conversation"; id: string; force?: boolean }
	// -- delegated workers (right workspace Workers pane) ---------------------
	/** Follow one worker's transcript: the server answers with worker_transcript
	 *  now and keeps pushing updates while the worker runs. */
	| { type: "open_worker"; workerId: number }
	| { type: "close_worker"; workerId: number }
	/** Abort ONE running worker; its siblings and the delegate call continue. */
	| { type: "cancel_worker"; workerId: number };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface SessionSummary {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
}

/** 会话转录中一条命中消息的定位锚点：会话载入后按 role + timestamp 在
 *  UiMessage[] 里找到对应消息，用于「搜索会话 → 跳到对应位置」。 */
export interface MessageAnchor {
	role: string;
	timestamp: number;
}

/** 会话内容搜索结果：会话摘要 + 命中消息锚点（可能为空 ——
 *  仅元数据/文件名命中时无从定位，跳转退化为直接打开会话）。 */
export interface SessionSearchResult extends SessionSummary {
	/** 按转录顺序排列的命中消息（最多若干条）；客户端取第一条做跳转。 */
	anchors: MessageAnchor[];
}

/**
 * A workspace directory this client has opened before (persisted per client in
 * <dataDir>/client-state.json, merged with cwds found in the session store).
 */
export interface ProjectSummary {
	/** Absolute path of the workspace directory. For a git repository this is
	 *  the MAIN checkout: linked worktrees of the same repository are listed in
	 *  `worktrees`, never as projects of their own. */
	path: string;
	/** Last time this workspace was used (ms epoch) — drives the sort order.
	 *  For a repository, the newest across all of its checkouts. */
	lastUsed: number;
	/** Every checkout of the repository, main first. Chats and sessions whose
	 *  cwd is one of these paths belong to this project; non-main entries get
	 *  a branch badge. Omitted for non-git directories. */
	worktrees?: WorktreeSummary[];
}

/** One checkout of a project's repository (see ProjectSummary.worktrees). */
export interface WorktreeSummary {
	/** Absolute checkout path (the cwd chats in it run under). */
	path: string;
	/** Checked-out branch; null when detached. */
	branch: string | null;
	/** Short HEAD hash — the label for a detached checkout. */
	head: string;
	/** The repository's main checkout (== ProjectSummary.path). */
	isMain: boolean;
	/** Locked by `git worktree lock` (or by a running agent). */
	locked: boolean;
	/** Lives under the managed `~/.pi/worktrees/<repo>/<slug>` layout the
	 *  CLI's /worktree command and this UI create. */
	managed: boolean;
}

/** 一个可选项：模型的 ask_user_question 问卷选项。preview 为选项被选中后
 *  在右侧展开的富文本（model 自选 markdown 或 HTML，前端走 Markdown(rawHtml)）。 */
export interface UiQuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

/** 模型 ask_user_question 的一道题。question/detail/header 允许 markdown/HTML
 *  混排（前端走 Markdown(rawHtml)），由模型自选、信任模型。 */
export interface UiQuestion {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: UiQuestionOption[];
	multiSelect?: boolean;
}

/** 一道题的用户回答（question_answer 回传）。selected 为选中的选项 label
 *  列表；custom 为用户在「Type something」里填的额外文本（可选）。 */
export interface QuestionAnswer {
	id: string;
	selected: string[];
	custom?: string;
}

/** 待用户回答的模型提问（ask_user_question）——服务端侧的事实源。
 *  `question_pending` 是即时通道（模型刚提问时推一次）；本类型同时挂在
 *  UiState.pendingQuestion 上，让重连/刷新/第二个标签页的客户端从快照里把
 *  对话框恢复出来（否则问卷只在「当时在线的那条连接」上可见）。 */
export interface UiPendingQuestion {
	/** 提问 id，question_answer 回传时原样带回。 */
	id: string;
	questions: UiQuestion[];
	/** 服务端超时时间戳（epoch ms）——前端显示倒计时，归零自动取消。
	 *  缺省 = 不限时（标准 pi 引擎：等人回答不设上限）。 */
	deadline?: number;
}

/** A background server the agent left running (listening-port diff around a
 *  bash tool run). Keyed by port. Managed from the 后台任务 panel: each entry
 *  can be stopped individually or all at once, and the list persists even
 *  after the conversation that started them ends. */
export interface BgServer {
	/** Port the server listens on (the stable key). */
	port: number;
	/** Process id of the listening process. */
	pid?: number;
	/** When the server/task was first detected or registered (ms epoch). */
	since: number;
	/** Best-effort process name (tasklist / ps), undefined when unknown. */
	name?: string;
	/** Best-effort full command line (PowerShell CIM / ps -o command=) so the
	 *  panel can show WHAT is actually running, undefined when unknown. */
	command?: string;
	/** 插件任务的活动状态文案（如轮询间隔、连接数），可经 update 刷新。 */
	status?: string;
}

/** One filename match from the global-search recursive workspace walk. */
export interface FileSearchResult {
	/** Workspace-relative path ("/"-separated). */
	path: string;
	name: string;
	type: "file" | "dir";
}
export interface FileEntry {
	name: string;
	/** Path relative to the workspace root ('' for the root itself); in machine
	 *  browse mode (files.absolute) this carries the absolute wire path. */
	path: string;
	type: "file" | "dir";
	/**
	 * Preview category (files only; undefined for dirs). "none" files are
	 * never previewed — the UI doesn't open them and read_file refuses them.
	 */
	kind?: "image" | "video" | "text" | "none";
}

// -- delegated workers -------------------------------------------------------

/** Lifecycle of a delegated worker, as reported by the PiAstra extension.
 *  `interrupted` = restored from a saved session where it never finished. */
export type UiWorkerStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** One delegated worker (PiAstra `delegate` tool). Mirrors the extension's
 *  public summary on the `piastra:workers` event channel. */
export interface UiWorker {
	/** Session-unique worker number (1-based, in start order). */
	id: number;
	/** The delegate tool call that started it (groups workers per card). */
	toolCallId?: string;
	role: string;
	model: string;
	task: string;
	status: UiWorkerStatus;
	/** One-line current activity ("→ read src/app.ts", "Thinking…", an error). */
	activity: string;
	started: number;
	ended?: number;
	/** Bounded recent tool lines kept by the extension (card preview). */
	recent: string[];
	/** Tail of the latest assistant text (card preview). */
	text: string;
	/** A transcript can be shown: the worker session is live in memory or its
	 *  saved JSONL is readable. */
	hasTranscript: boolean;
}

/** One worker's conversation, in the same shape as the main chat so the
 *  pane renders it with the ordinary message components. */
export interface UiWorkerTranscript {
	workerId: number;
	messages: UiMessage[];
	/** In-flight assistant message while the worker streams. */
	streamingMessage: UiMessage | null;
	/** Where the messages came from; "none" = nothing readable (yet). */
	source: "live" | "file" | "none";
}

// -- source-control panel (wire shapes shared by scm_data) -------------------

export interface ScmFileEntry {
	/** Repo-relative path. */
	path: string;
	/** porcelain index (staged) status letter. */
	x: string;
	/** porcelain worktree status letter. */
	y: string;
}

export interface ScmBranchEntry {
	name: string;
	current: boolean;
	/** Remote name for remote-tracking refs ("origin/main" → "origin"). */
	remote?: string | boolean;
}

export interface ScmCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	/** The graph prefix emitted by `git log --graph` (for example `| * `). */
	graph: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

// ---------------------------------------------------------------------------
// Custom model configuration (agentDir/models.json) — browser-editable shape
// ---------------------------------------------------------------------------

/** One model definition inside a custom provider. */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	/** Per-model api type. Multi-api providers (opencode-go) mix
	 *  anthropic-messages with openai-completions/responses; without this the
	 *  provider-level api would mis-route part of the catalog. */
	api?: string;
	/** Per-model upstream base URL — wins over the provider-level baseUrl
	 *  (opencode-go uses /zen/go for anthropic and /zen/go/v1 for openai). */
	baseUrl?: string;
	/** Adapter compatibility overrides (thinkingFormat, maxTokensField, …). */
	compat?: Record<string, unknown>;
	/** Billing metadata, preserved verbatim. */
	cost?: Record<string, unknown>;
	/** pi thinking-level → provider-value mapping, preserved verbatim. */
	thinkingLevelMap?: Record<string, unknown>;
}

/** A custom provider block in models.json (providers.<id>). */
export interface UiProviderConfig {
	providerId: string;
	name?: string;
	/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	/** headers are NOT returned to the browser — they can contain Authorization
	 *  / API-key values; saveModelConfig preserves them server-side. */
	models: UiModelConfigEntry[];
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
}

/** One stored API key for a built-in provider (NICKNAME only — the raw apiKey
 *  and any masked fragment never leave the server). A provider can hold several
 *  keys — exactly one is active and routes the provider's requests. The UI groups
 *  models by key name so clicking a model under a key activates that key on the
 *  fly; the server resolves the stored value from the name. */
export interface ProviderKeyInfo {
	/** User-chosen (or auto-generated) name — the ONLY identifier the frontend
	 *  sees. Unique per provider. */
	name: string;
	/** true = this key currently routes requests for the provider. */
	active: boolean;
}
/** ONE RUNNING conversation (each runs its own session in parallel). The
 *  list is GLOBAL across projects — a background run from another workspace
 *  stays visible until it is opened and left without continuing — and only
 *  contains conversations that were displaced to the background while still
 *  streaming; background-finish keeps them listed, opening-and-leaving-
 *  without-continuing removes them. cwd lets the client group by project. */
export interface ConversationSummary {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	/** Transcript file backing this conversation, so the sidebar can hide the
	 *  matching history row instead of listing the same chat twice. */
	sessionPath?: string;
}

// ---------------------------------------------------------------------------
// Settings (system prompt / skills / extensions / presets)
// ---------------------------------------------------------------------------

/** One loaded skill, with whether it is currently enabled. Disabled skills are
 *  excluded from the system prompt and from the /skill: command catalog. */
export interface UiSkillInfo {
	name: string;
	description: string;
	enabled: boolean;
}

/** One loaded extension, with whether it is currently enabled. Disabled
 *  extensions are unloaded from the runtime (tools/commands disappear). */
export interface UiExtensionInfo {
	/** Stable identity for the toggle: the npm spec for packages, the resolved
	 *  entry path otherwise. */
	id: string;
	/** Display label: npm package spec (npm:pi-foo) or the path basename. */
	name: string;
	/** Resolved entry path. */
	path: string;
	enabled: boolean;
}

/** A named combination of prompt (compose template + per-source overrides) +
 *  disabled skills/extensions that the user can re-apply in one click. Persisted
 *  per client. promptMode/customSystemPrompt 是遗留字段（旧预设）。 */
export interface UiSettingsPreset {
	name: string;
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
}

/** Full settings state pushed to the browser (settings_state). */
export interface UiSettingsState {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	/** 组合模板 + 各来源覆盖（见 server/prompt-composer.ts）。主会话系统提示词
	 *  = 模板里 {{token}} 展开各来源提示词；覆盖优先于自动内容。 */
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** 统一 Agent 工具禁用名单（单源；live 生效无需 reload）。 */
	disabledAgentTools: string[];
	/** @deprecated 遗留别名（由 disabledAgentTools 推导）：全开才算开。Off → terminal_*
	 *  tools are removed from the active set and the guidance prompt is not injected. */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）：bash 执行体改为持久终端（可见/保留状态/静默转后台）。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值毫秒数（0 = 一直等到命令结束）。 */
	terminalBashIdleMs: number;
	/** 问卷提问开关（默认开）。关 → 模型不再弹问卷对话框。 */
	questionnaireEnabled: boolean;
	/** 思考文本是否换行（默认开 = pre-wrap；关 = 长行横向滚动）。 */
	thinkingWrap: boolean;
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。 */
	toolsWrap: boolean;
	/** skill 全文注入名单（默认空 = 名录模式）：名单里的技能 {{skills}} 展开正文。 */
	skillsFullText: string[];
	/** The FULL system prompt actually in effect for the active conversation
	 *  (compose render: template + per-source overrides + project context +
	 *  skills + tool guidance). Read-only view source for the settings panel;
	 *  empty until the session is ready. */
	effectiveSystemPrompt: string;
	/** 每个来源 token 当前的默认（自动）内容 —— {{token}} 未覆盖时展开成的文本
	 *  （设置面板「各来源」行只读预览用；键 = prompt-composer token，空串 =
	 *  该来源目前无自动内容；会话未就绪时为空对象）。 */
	promptSourceDefaults: Record<string, string>;
	/** 发给模型的 function-calling 工具定义（name + description + parameters
	 *  JSON Schema）只读文本 —— 设置面板「查看当前完整提示词」里与系统提示词
	 *  正文并排展示，方便看到完整初始上下文；会话未就绪时为空串。 */
	toolsSchema: string;
	skills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
	presets: UiSettingsPreset[];
	/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。 */
	retryMaxAttempts: number;
}
export type ServerMessage =
	| {
			type: "ready";
			clientId: string;
			serverVersion: string;
			/** Wire-protocol version (server/protocol-version.ts). The client
			 *  compares it against its own copy — a mismatch means the page was
			 *  loaded before an app update and must be refreshed. */
			protocolVersion?: number;
			/** This package's own version (`serverVersion` is the pi SDK's). The
			 *  client used to learn it from the update check, which a managed
			 *  instance never runs. */
			appVersion?: string;
			/** PI_WEB_MANAGED=1 — updates come from outside, so the client hides
			 *  the update badge, the UPDATE panel and the plugin market. The
			 *  server refuses those messages anyway (server/managed.ts). */
			managed?: boolean;
			/** PI_WEB_TABS — the tabs this instance offers; absent means all of
			 *  them. The client does not draw the others and the server refuses
			 *  their messages (server/tabs.ts). */
			tabs?: string[];
			/** Supervising service manager, when this instance was started by
			 *  `pi-web-ui server start|install` (server/launch-origin.ts). Absent =
			 *  foreground/dev/Docker: no supervisor, so the client hides the
			 *  "restart service" action and the server refuses restart_service. */
			service?: UiServiceInfo;
	  }
	| { type: "snapshot"; state: UiState }
	| {
			/** Incremental snapshot: everything EXCEPT `messages` travels in
			 *  `state`, and only messages appended since baseRev ride in
			 *  `appended`. Persisted messages are content-immutable with stable
			 *  ids, so any mid-array change/truncation (switch session, fork,
			 *  compaction) makes the server fall back to a full snapshot instead.
			 *
			 *  Droppable under backpressure exactly like `snapshot`: a dropped
			 *  delta breaks the client's rev chain, and the next surviving full
			 *  snapshot (or the client's get_state after detecting the gap)
			 *  reconciles — memory stays bounded, correctness self-heals. */
			type: "snapshot_delta";
			conversationId: string;
			rev: number;
			baseRev: number;
			appended: UiMessage[];
			state: Omit<UiState, "messages" | "rev"> & { rev: number };
	  }
	| {
			// Global running-conversation list (see ConversationSummary): all
			// listed conversations across every project. activeId is the active
			// conversation even when it isn't listed (fresh chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| {
			type: "tool_delta";
			conversationId: string;
			/** Per-conversation monotonic sequence, shared with message_delta —
			 *  a gap tells the client to resync via get_state. */
			seq: number;
			toolCallId: string;
			toolName: string;
			delta: string;
	  }
	/** Live assistant-message increment (thinking/text deltas + usage) that
	 *  deliberately BYPASSES the snapshot channel: send() drops snapshots under
	 *  backpressure, but this message is small and must always get through, so
	 *  big sessions keep rendering live even when full snapshots are dropped.
	 *  seq is per-conversation monotonic — a gap tells the client to resync via
	 *  get_state. The next snapshot remains authoritative and reconciles any
	 *  drift (deltas only patch streamingMessage + stats.tokens). */
	| {
			type: "message_delta";
			conversationId: string;
			seq: number;
			messageId: string;
			usage: { input: number; output: number; total: number } | null;
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
	  }
	/** A tool FINISHED executing (SDK tool_execution_end). Unlike toolResult
	 *  snapshot messages, this arrives the moment the command exits — before
	 *  the model's next response starts — so the UI can show "done, waiting
	 *  for the model" instead of an indefinite "running". */
	| {
			type: "tool_status";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			/** Exit code when the tool result carries one (bash returns it in details). */
			exitCode?: number;
			/** tool_execution_start → tool_execution_end, in ms. */
			durationMs?: number;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; conversationId?: string; terminalId: string; data: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; commands: CommandDef[]; path: string }
	/** The slash-command catalog for the chat input (builtin + extension +
	 *  prompt template + skill commands). Pushed on attach, on project switch
	 *  and on request (get_commands). */
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }
	/** The watched git dir changed outside the panel (terminal commit,
	 *  CLI, IDE) — the client should re-run its scm_status query. */
	| { type: "scm_changed" }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	/** A followed worker's transcript (reply to open_worker, then pushed on
	 *  change while the worker runs). Whole-list replace; worker transcripts
	 *  are bounded, so no delta chain is needed. */
	| { type: "worker_transcript"; conversationId: string; transcript: UiWorkerTranscript }
	/** Persisted session list for ONE project. `cwd` is the queried project
	 *  directory (echoed back from `list_sessions`, or the active cwd on a
	 *  spontaneous push); the client keys its per-project cache by this field.
	 *  Omitted only by engines/older callers that never scope the query — the
	 *  client falls back to the current cwd. */
	| { type: "sessions"; cwd?: string; sessions: SessionSummary[] }
	/** Filename matches for the global search panel (reqId echo). Always sent
	 *  in reply to a search_files request — ok:false means the walk failed. */
	| {
			type: "search_files_result";
			reqId: number;
			ok: boolean;
			results: FileSearchResult[];
			/** Walk stopped early (result/time/entry budget hit). */
			truncated?: boolean;
	  }
	/** Conversation-content matches for the global search panel (reqId echo).
	 *  ok:false means the transcript scan failed — treat as no results. */
	| {
			type: "session_search_results";
			reqId: number;
			query: string;
			ok: boolean;
			results: SessionSearchResult[];
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	/** Outcome of worktree_add / worktree_remove. */
	| {
			type: "worktree_result";
			op: "add" | "remove";
			ok: boolean;
			/** Checkout path (the created/reused one for add; the target for remove). */
			path: string;
			branch?: string;
			/** remove only: refused because of uncommitted changes — retry with force. */
			dirty?: boolean;
			error?: string;
	  }
	| {
			type: "files";
			path: string;
			parent: string | null;
			entries: FileEntry[];
			/**
			 * The directory had more entries than the platform cap (win32: 2000,
			 * posix: 500) — the list was cut short. UI shows a hint when true.
			 */
			truncated: boolean;
			/**
			 * true = 机器浏览模式：path/entries 为绝对路径（盘符根 "C:"、"@root"
			 *  机器根，或 "/" 开头的 posix 路径），允许越过工作区根导航到别的盘。
			 *  false/缺省 = 工作区相对视图（原语义）。
			 */
			absolute?: boolean;
	  }
	/** Content of a workspace file for the preview panel. */
	/** The server fs.watches the currently-listed directory and pushes this on
	 *  any file change so the client can refresh the listing instantly
	 *  (path = the listed directory; unknown/unsupported fs falls back to the
	 *  10s polling). */
	| { type: "file_changed"; path: string }
	| {
			type: "file_content";
			path: string;
			name: string;
			/**
			 * Preview category: media kinds render via the /api/file HTTP
			 * endpoint (text stays empty); "none" means not previewable.
			 */
			kind: "image" | "video" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			/** Total line count of the *read* portion (equal to lines in text). */
			lines: number;
			/** Total file size in bytes. */
			size: number;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	/** All stored API keys per built-in provider (masked). Keyed by providerId. */
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	/** Result of a fetch_models probe: ok + the advertised models (id plus
	 *  whatever metadata the endpoint provided — contextWindow / vision input /
	 *  reasoning / name / maxTokens — same shape as models.json rows), or an
	 *  error string. */
	| {
			type: "fetch_models_result";
			reqId: number;
			ok: boolean;
			models?: UiModelConfigEntry[];
			error?: string;
	  }
	/** Result of refresh_provider_models: merged into the saved entry; added =
	 *  newly-discovered model ids, total = models now in the saved config. */
	| {
			type: "refresh_provider_result";
			reqId: number;
			ok: boolean;
			added?: number;
			total?: number;
			error?: string;
	  }
	/** Result of clone_provider: a ready-to-edit custom-provider draft
	 *  (baseUrl + model catalog copied from the built-in provider; apiKey
	 *  intentionally empty). Not persisted until save_model_config.
	 *  Multi-api providers (e.g. opencode) return `configs` (one per api) —
	 *  `config` is kept as configs[0] for backward compat. */
	| {
			type: "clone_provider_result";
			reqId: number;
			ok: boolean;
			config?: UiProviderConfig;
			configs?: UiProviderConfig[];
			error?: string;
	  }
	/** Result of an install_pi_agent run (npm i -g finished or failed). */
	| { type: "install_result"; ok: boolean; detail: string }
	// -- source-control panel results (see scm_status / scm_filediff / scm_commit) --
	| {
			type: "scm_data";
			reqId: number;
			kind: "status" | "history" | "filediff" | "commit";
			ok: boolean;
			error?: string;
			/** status payload — fields optional so one wire type carries every
			 *  kind; the client reads the ones matching `kind`. */
			notRepo?: boolean;
			branch?: string;
			detached?: boolean;
			upstream?: string | null;
			ahead?: number;
			behind?: number;
			upstreamGone?: boolean;
			files?: ScmFileEntry[];
			branches?: ScmBranchEntry[];
			stats?: Record<string, [number, number]>;
			history?: ScmCommitEntry[];
			/** filediff payload */
			stagedText?: string;
			worktreeText?: string;
			untracked?: boolean;
			/** commit payload */
			text?: string;
	  }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	/** Structured todo list of the ACTIVE conversation (pi-todo bridge; see
	 *  server/todo-state.ts). Replaces the extension's text widget. */
	| { type: "todos"; tasks: TodoTask[]; nextId: number; runIds: number[]; running: boolean }
	| {
			type: "dialog";
			id: number;
			kind: "select" | "confirm" | "input";
			title: string;
			args: unknown[];
	  }
	/** The server resolved (or abandoned) a dialog — the client must close it. */
	| { type: "dialog_closed"; id: number }
	/** Current settings state (system prompt mode/text, enabled skills &
	 *  extensions, saved presets). Pushed on attach and after every settings
	 *  change. */
	| { type: "settings_state"; settings: UiSettingsState }
	/** The model asked the user (ask_user_question tool). The frontend
	 *  shows a dialog and answers via question_answer. One pending
	 *  question at a time per client (the runtime blocks the agent loop). */
	| {
			type: "question_pending";
			id: string;
			/** 服务端超时时间戳（epoch ms，P0-6）；前端显示倒计时，归零自动取消。 */
			deadline?: number;
			questions: UiQuestion[];
	  }
	/** A live authoritative lifecycle signal. It is never included in a
	 * snapshot and carries no prompt/question/error detail. */
	| {
			type: "notification_event";
			eventId: string;
			conversationId: string;
			kind: "run-completed" | "input-required" | "run-failed";
			projectName: string;
			sessionName?: string;
	  }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running, detected via
	 *  listening-port diffs around bash tool runs). Per CLIENT, not per
	 *  conversation — the list survives conversation switches/ends and only
	 *  empties when the tasks are stopped (individually or all at once) or the
	 *  process exits on its own. Pushed on change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] };
