/**
 * client-state — 每浏览器客户端的持久化 UI 状态（<dataDir>/client-state.json）：
 * 最近项目/工作目录、目标审查偏好、设置面板状态（提示词模式 + 技能/插件开关 +
 * 视觉桥偏好）、命名预设。文件 I/O 一律 best-effort：持久化故障绝不能
 * 弄崩 server 或阻塞会话。
 *
 * 从 agent-service.ts 抽出，行为保持不变。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deriveLegacy, legacyToDisabled, normalizeDisabledAgentTools } from "./tool-manager.js";

/** System-prompt mode: append the custom text to the built prompt, or replace
 *  the whole system prompt with it. (遗留字段：主会话已迁移到 compose 模板，
 *  仅 DSH 子系统与旧存档仍读写它。) */
export type PromptMode = "append" | "replace";

/** 大模型 API 出错自动重试次数的默认值（SDK 默认 3）。 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 6;

/** 归一化重试次数：非数值回落默认，钳制到 [0, 100] 整数。 */
export function normalizeRetryMaxAttempts(v: unknown): number {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_RETRY_MAX_ATTEMPTS;
	return Math.min(100, Math.max(0, n));
}

/** 归一化技能名单：字符串数组原样过滤；其他（含旧 bool 开关）回落空数组。 */
export function normalizeSkillList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Settings-panel state (system prompt + disabled skills/extensions). */
export interface ClientSettings {
	promptMode: PromptMode;
	customSystemPrompt: string;
	/** 组合模板（主会话系统提示词 = 自由拼装 {{token}}，见 server/prompt-composer.ts）。
	 *  空 = 默认模板（全部自动段按自然顺序）；promptMode/customSystemPrompt 为
	 *  遗留字段（旧存档迁移到 overrides，DSH 仍共用存储）。 */
	promptTemplate: string;
	/** 每个来源 token 的独立覆盖文本（空串/缺省 = 用该来源的自动内容）。 */
	promptOverrides: Record<string, string>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Persistent-terminal tools on/off（遗留别名，兼容旧客户端/旧存档；以 disabledAgentTools 为准同步）。 */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）。开 → bash 工具的执行体改为持久终端：命令在可见
	 *  PTY 里跑、跨调用保留 shell 状态（cd/venv/ssh），静默超阈值自动转后台。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值（毫秒，默认 15000；0 = 一直等到结束）。 */
	terminalBashIdleMs: number;
	/** Agent 工具禁用名单（统一开关，见 tool-manager.ts；live 生效无需 reload）。 */
	disabledAgentTools: string[];
	/** 问卷提问开关（默认开；关 → 不弹对话框且 ask_user_question 工具同步禁用。不进预设）。 */
	questionnaireEnabled: boolean;
	/** 思考块默认折叠与否（默认关 = 折叠；开 = 始终完整展开并自动换行，流式推理
	 *  也实时可见）。纯 UI 偏好，与视觉桥 / disabledPlugins 一样不进预设。 */
	thinkingWrap: boolean;
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。纯 UI 偏好，不进预设。 */
	toolsWrap: boolean;
	/** skill 全文注入名单（默认空 = 名录模式）。名单里的技能 {{skills}} 展开正文
	 *  （oh-my-pi 式全文注入；单文件 8KB、总量 32KB 封顶，超限回落名录）。
	 *  进预设；逐 run 实时读取，改动下一轮即生效。 */
	skillsFullText: string[];
	/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。SDK
	 *  settings.retry.maxRetries 的按客户端覆盖（SDK 默认 3），经
	 *  applyOverrides 注入各会话的 SettingsManager（session.reload()
	 *  会重读磁盘，需重放）。 */
	retryMaxAttempts: number;
}

/** A named combo of prompt + skill/extension toggles the user can re-apply.
 *  UI-only prefs are intentionally NOT part of a preset. */
export interface SettingsPreset extends Omit<ClientSettings, "questionnaireEnabled" | "thinkingWrap" | "toolsWrap"> {
	name: string;
}

/** Stable identity of an extension for the enable/disable toggle: the npm
 *  spec for packages (survives version bumps), the resolved entry path
 *  otherwise. */
export function extensionKey(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string {
	const src = e.sourceInfo;
	if (src?.origin === "package" && src.source) return src.source;
	return src?.path ?? e.path;
}

/** All identities an extension may be disabled by. The SDK applies
 *  `sourceInfo` only AFTER extensionsOverride runs (resource-loader reload():
 *  override first, applyExtensionSourceInfo second), so inside the override a
 *  package extension still has no sourceInfo and extensionKey() falls back to
 *  the raw entry path — which never matches the "npm:<pkg>" id the settings
 *  panel stores. Derive the package name from the entry path
 *  (.../node_modules/<pkg>/... or .../node_modules/@scope/<pkg>/...) so both
 *  sides agree. */
export function extensionKeyCandidates(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string[] {
	const keys = new Set<string>([extensionKey(e)]);
	const norm = e.path.replace(/\\/g, "/");
	const marker = "/node_modules/";
	const idx = norm.lastIndexOf(marker);
	if (idx !== -1) {
		const segs = norm.slice(idx + marker.length).split("/");
		// Scoped package @scope/name spans two segments.
		const name = segs[0]?.startsWith("@") && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
		if (name) keys.add(`npm:${name}`);
	}
	return [...keys];
}

/** Whether an extension is covered by the disabled list (any identity match). */
export function isExtensionDisabled(
	e: {
		sourceInfo?: { origin?: string; source?: string; path?: string };
		path: string;
	},
	disabled: readonly string[],
): boolean {
	if (disabled.length === 0) return false;
	const keys = extensionKeyCandidates(e);
	return disabled.some((d) => keys.includes(d));
}

export interface ClientState {
	/** Absolute path of the workspace this client last used. */
	lastCwd?: string;
	/** Workspaces this client opened before, most recent first (capped at 30). */
	projects: { path: string; lastUsed: number }[];
	/** Settings-panel state (system prompt mode/text + disabled skills/
	 *  extensions) so toggles survive a reload. */
	settings?: ClientSettings;
	/** Named settings presets (prompt + skill/extension toggles combos). */
	presets?: SettingsPreset[];
	/** Conversations that were STILL STREAMING when the server last shut down
	 *  (SIGTERM / self-update restart). Consumed once on the next attach so
	 *  the user learns a run was lost instead of wondering where it went. */
	interrupted?: { title: string; cwd: string; at: number }[];
	/** Workspaces the user explicitly removed from the recent list. Kept as
	 *  tombstones so cwds re-discovered from session files stay hidden until
	 *  the workspace is opened again. */
	removedProjects?: string[];
	/** Per-project provider key preference: cwd -> provider -> keyName.
	 *  Remember which key was last used for each provider in each project,
	 *  so switching projects restores the correct key (model is already
	 *  per-conversation, but key was global). */
	projectProviderKeys?: Record<string, Record<string, string>>;
	/** Per-project model preference: cwd -> "provider/id". Saved IMMEDIATELY when
	 *  the user selects a model (not only after a turn — the SDK only flushes a
	 *  model_change entry to disk once an assistant message exists, so a fresh
	 *  conversation's model choice would otherwise be lost on project switch).
	 *  Together with projectProviderKeys it makes the whole {model, key} pair
	 *  project-bound, so switching back restores both right away. */
	projectModels?: Record<string, string>;
}

/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;

	constructor(private filePath: string) {}

	/** 长期设置（设置面板 config + 预设 + 标记开关）的固定存储键。
	 *
	 * 为什么用固定全局键而非 per-clientId：clientId 存 sessionStorage（每标签页独立、
	 * 关浏览器即失），按 clientId 存设置会在每次新会话/重启后生成新 id → 设置全部重置、
	 * 且各标签页/浏览器各有一套互不同步。改为全局共享后：所有客户端（标签页/浏览器）
	 * 使用同一套配置，且持久化在服务端，重启不丢（「同一套配置」）。会话级状态
	 * （最近项目 / lastCwd / 项目模型与密钥等）仍按 clientId 各自保留。 */
	private static readonly GLOBAL_SETTINGS_KEY = "__settings__";

	/** <dataDir>（client-state.json 的上一级）——共享配置（子代理模板库等）落在这里。 */
	get dataDir(): string {
		return dirname(this.filePath);
	}

	private load(): Record<string, ClientState> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, ClientState>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			// Atomic write (tmp + rename): a crash mid-write must never leave a
			// half-written JSON — that would wipe ALL persisted state (recent
			// projects / presets / settings / goal prefs) on next load.
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + "\n");
			renameSync(tmp, this.filePath);
		} catch {
			// best effort
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/** Remember which workspace a client last used; bumps its project entry.
	 *  `asProject: false` only records the restore target — used when the cwd
	 *  changed as a side effect of opening a chat, which must not turn a random
	 *  shell directory into a sidebar project. */
	remember(clientId: string, cwd: string, asProject = true): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.lastCwd = cwd;
		if (!asProject) {
			this.save();
			return;
		}
		const now = Date.now();
		state.projects = [{ path: cwd, lastUsed: now }, ...state.projects.filter((p) => p.path !== cwd)].slice(0, 30);
		// Opening the workspace again clears its removal tombstone.
		if (state.removedProjects?.length) {
			state.removedProjects = state.removedProjects.filter((p) => p !== cwd);
		}
		this.save();
	}

	/** Drop one workspace from the recent-project list (user-requested removal).
	 *  Records a tombstone too: pushProjects() re-discovers cwds from session
	 *  files on every listing, so without it the entry would instantly reappear. */
	removeProject(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.projects = state.projects.filter((p) => p.path !== cwd);
		if (state.lastCwd === cwd) delete state.lastCwd;
		const removed = new Set(state.removedProjects ?? []);
		removed.add(cwd);
		state.removedProjects = [...removed];
		this.save();
	}

	/** Tombstoned projects (explicitly removed by the user) for filtering the
	 *  merged recent-project list. */
	getRemovedProjects(clientId: string): string[] {
		return this.load()[clientId]?.removedProjects ?? [];
	}

	/** Remember conversations that were still streaming at shutdown (best-
	 *  effort; called during the graceful-shutdown path). */
	saveInterrupted(clientId: string, list: { title: string; cwd: string; at: number }[]): void {
		if (list.length === 0) return;
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.interrupted = list.slice(0, 8);
		this.save();
	}

	/** Consume the interrupted-conversation record (returns and clears it) —
	 *  called once on the client's first attach after a restart. */
	takeInterrupted(clientId: string): ClientState["interrupted"] {
		const all = this.load();
		const state = all[clientId];
		const list = state?.interrupted;
		if (list?.length && state) {
			delete state.interrupted;
			this.save();
		}
		return list;
	}

	/** 设置面板状态（系统提示词模式/文字 + 禁用技能/扩展）——全局共享同一套配置。 */
	getSettings(_clientId: string): ClientSettings {
		const s = this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY];
		const stored = s?.settings;
		// 旧存档（promptMode/customSystemPrompt）迁移到 compose：追加文字成为独立
		// {{append}} 覆盖、替换文字成为 {{soul}} 覆盖；无自定义则用默认模板。
		let promptTemplate = "";
		let promptOverrides: Record<string, string> = {};
		if (stored?.promptTemplate !== undefined) {
			promptTemplate = stored.promptTemplate ?? "";
			promptOverrides = { ...stored?.promptOverrides };
		} else if (stored && typeof stored.customSystemPrompt === "string" && stored.customSystemPrompt.trim()) {
			promptOverrides = {
				[stored.promptMode === "replace" ? "soul" : "append"]: stored.customSystemPrompt,
			};
		}
		return {
			promptMode: stored?.promptMode === "replace" ? "replace" : "append",
			customSystemPrompt: stored?.customSystemPrompt ?? "",
			promptTemplate,
			promptOverrides,
			disabledSkills: stored?.disabledSkills ?? [],
			disabledExtensions: stored?.disabledExtensions ?? [],
			disabledAgentTools: legacyToDisabled(stored ?? {}),
			// 新字段已存在时遗留三开关以它为准推导（旧文件才读遗留值），保证两边一致。
			terminalToolsEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).terminalToolsEnabled
					: (stored?.terminalToolsEnabled ?? false),
			terminalBash: stored?.terminalBash ?? false,
			terminalBashIdleMs: stored?.terminalBashIdleMs ?? 15_000,
			questionnaireEnabled:
				stored?.disabledAgentTools !== undefined
					? deriveLegacy(legacyToDisabled(stored)).questionnaireEnabled
					: (stored?.questionnaireEnabled ?? true),
			thinkingWrap: stored?.thinkingWrap ?? false,
			toolsWrap: stored?.toolsWrap ?? false,
			skillsFullText: normalizeSkillList(stored?.skillsFullText),
			retryMaxAttempts: normalizeRetryMaxAttempts(stored?.retryMaxAttempts),
		};
	}

	/** Persist the settings-panel state (partial merge) — global shared config. */
	saveSettings(_clientId: string, settings: Partial<ClientSettings>): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		const cur = state.settings ?? ({} as ClientSettings);
		state.settings = {
			promptMode: settings.promptMode ?? cur.promptMode ?? "append",
			customSystemPrompt: settings.customSystemPrompt ?? cur.customSystemPrompt ?? "",
			promptTemplate: settings.promptTemplate ?? cur.promptTemplate ?? "",
			promptOverrides: { ...(settings.promptOverrides ?? cur.promptOverrides) },
			disabledSkills: settings.disabledSkills ?? cur.disabledSkills ?? [],
			disabledExtensions: settings.disabledExtensions ?? cur.disabledExtensions ?? [],
			disabledAgentTools: normalizeDisabledAgentTools(settings.disabledAgentTools ?? cur.disabledAgentTools),
			terminalToolsEnabled: settings.terminalToolsEnabled ?? cur.terminalToolsEnabled ?? false,
			terminalBash: settings.terminalBash ?? cur.terminalBash ?? false,
			terminalBashIdleMs: settings.terminalBashIdleMs ?? cur.terminalBashIdleMs ?? 15_000,
			questionnaireEnabled: settings.questionnaireEnabled ?? cur.questionnaireEnabled ?? true,
			thinkingWrap: settings.thinkingWrap ?? cur.thinkingWrap ?? false,
			toolsWrap: settings.toolsWrap ?? cur.toolsWrap ?? false,
			skillsFullText: normalizeSkillList(settings.skillsFullText ?? cur.skillsFullText),
			retryMaxAttempts: normalizeRetryMaxAttempts(
				settings.retryMaxAttempts ?? cur.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
			),
		};
		this.save();
	}

	/** Named settings presets for a client (empty if never saved) — global shared. */
	getPresets(_clientId: string): SettingsPreset[] {
		return (this.load()[ClientStateStore.GLOBAL_SETTINGS_KEY]?.presets ?? []).map((p) => ({
			...p,
			// Older presets predate the configurable retry count.
			retryMaxAttempts: normalizeRetryMaxAttempts(p.retryMaxAttempts),
		}));
	}

	/** Persist the named settings presets — global shared config. */
	savePresets(_clientId: string, presets: SettingsPreset[]): void {
		const all = this.load();
		const state = (all[ClientStateStore.GLOBAL_SETTINGS_KEY] ??= { projects: [] });
		state.presets = presets;
		this.save();
	}

	/** Get per-project provider keys for a cwd, or undefined. */
	getProjectProviderKeys(clientId: string, cwd: string): Record<string, string> | undefined {
		return this.load()[clientId]?.projectProviderKeys?.[cwd];
	}

	/** Get a single provider's saved key for a project. */
	getProjectProviderKey(clientId: string, cwd: string, provider: string): string | undefined {
		return this.load()[clientId]?.projectProviderKeys?.[cwd]?.[provider];
	}

	/** Remember which key was last used for a provider in a project. */
	saveProjectProviderKey(clientId: string, cwd: string, provider: string, keyName: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		const map = (state.projectProviderKeys ??= {});
		const inner = (map[cwd] ??= {});
		inner[provider] = keyName;
		this.save();
	}

	/** Delete a per-project provider key (e.g. when the key is removed). */
	deleteProjectProviderKey(clientId: string, cwd: string, provider: string): void {
		const all = this.load();
		const inner = all[clientId]?.projectProviderKeys?.[cwd];
		if (!inner || !(provider in inner)) return;
		delete inner[provider];
		if (Object.keys(inner).length === 0) {
			delete all[clientId]!.projectProviderKeys![cwd];
		}
		this.save();
	}

	/** Remove one provider from EVERY project's saved keys (all clients, all
	 *  cwds) — e.g. the provider was cleared and returned to unconfigured.
	 *  Returns the number of entries removed. */
	deleteProviderEverywhere(provider: string): number {
		const all = this.load();
		let removed = 0;
		for (const state of Object.values(all)) {
			const map = state.projectProviderKeys;
			if (!map) continue;
			for (const [cwd, inner] of Object.entries(map)) {
				if (inner && provider in inner) {
					delete inner[provider];
					removed++;
					if (Object.keys(inner).length === 0) delete map[cwd];
				}
			}
			if (map && Object.keys(map).length === 0) delete state.projectProviderKeys;
		}
		if (removed > 0) this.save();
		return removed;
	}

	/** Fix every project that still references a deleted key: point it at the
	 *  key that took over (`newActive`), or drop the reference when the
	 *  provider has no keys left (`newActive` null). A key deletion made in
	 *  one project must not keep haunting every other project that once used
	 *  the same key on every project switch. Returns entries touched. */
	repointDeletedKeyEverywhere(provider: string, deletedKeyName: string, newActive: string | null): number {
		const all = this.load();
		let touched = 0;
		for (const state of Object.values(all)) {
			const map = state.projectProviderKeys;
			if (!map) continue;
			for (const [cwd, inner] of Object.entries(map)) {
				if (inner?.[provider] !== deletedKeyName) continue;
				if (newActive) inner[provider] = newActive;
				else {
					delete inner[provider];
					if (Object.keys(inner).length === 0) delete map[cwd];
				}
				touched++;
			}
			if (map && Object.keys(map).length === 0) delete state.projectProviderKeys;
		}
		if (touched > 0) this.save();
		return touched;
	}

	/** Get the model the user last selected in a project, or undefined. */
	getProjectModel(clientId: string, cwd: string): string | undefined {
		return this.load()[clientId]?.projectModels?.[cwd];
	}

	/** Remember the model last selected in a project (immediate, not after a turn). */
	saveProjectModel(clientId: string, cwd: string, modelId: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		(state.projectModels ??= {})[cwd] = modelId;
		this.save();
	}

	/** Drop the per-project model memory for a project (e.g. when the model is
	 *  removed from the catalog). */
	deleteProjectModel(clientId: string, cwd: string): void {
		const all = this.load();
		const map = all[clientId]?.projectModels;
		if (!map || !(cwd in map)) return;
		delete map[cwd];
		if (Object.keys(map).length === 0) delete all[clientId]!.projectModels;
		this.save();
	}
}
