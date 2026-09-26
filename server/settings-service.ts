/**
 * Settings service — 从 agent-service.ts 抽出（系统提示词 / 技能插件开关 /
 * 目标审查提示词 / 预设 / 视觉桥偏好）。设置持久化在 client-state.json 按客户端隔离。
 *
 * 经 SettingsHost 回调与 ClientSession 解耦：本模块只管「设置状态 + 面板推送 +
 * 预设存取 + 何时需要 reload」，真正动 runtime 的 session.reload() 走宿主回调
 * （reloadSession 里还会刷新斜杠命令目录）。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, UiExtensionInfo, UiSettingsState, UiSkillInfo } from "./protocol.js";
import {
	extensionKey,
	normalizeRetryMaxAttempts,
	normalizeSkillList,
	type ClientStateStore,
	type ClientSettings,
	type PromptMode,
} from "./client-state.js";
import { deriveLegacy, foldLegacyIntoDisabled, normalizeDisabledAgentTools } from "./tool-manager.js";

/** Host capabilities ClientSession provides (narrow, so the service is testable alone). */
export interface SettingsHost {
	clientId: string;
	stateStore: ClientStateStore;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** 当前活动对话的 session（未就绪时调用方自行 try/catch）。 */
	getSession: () => AgentSession;
	/** 会话工作区（磁盘校验“已删除的 skill”用）。 */
	cwd: () => string;
	/** pi 配置目录（<agentDir>/skills 是技能来源之一）。 */
	agentDir: () => string;
	isStreaming: () => boolean;
	/** session.reload() + 刷新斜杠命令目录。 */
	reloadSession: () => Promise<void>;
	/** 把设置面板的出错重试次数即时注入各会话（无需 reload；reload 后由
	 *  调用方重放，见 agent-service applyRetryOverrides）。 */
	applyRetryOverrides: () => void;
	/** 把统一工具开关即时应用到活动会话的 ActiveSet（无需 reload；
	 *  reload/创建后由调用方重放，见 agent-service applyToolGating）。 */
	applyToolGating: () => void;
	/** 当前会话提示词快照（设置面板预览用；会话未就绪时 full="" 且 texts={}）。
	 *  full = 实际生效的完整系统提示词（组合模式 = 模板 + 各来源自动/覆盖内容渲染结果）；
	 *  texts = 各来源 token 当前的默认（自动）内容（未覆盖时 {{token}} 展开值）；
	 *  toolsSchema = 发给模型的 function-calling 工具定义（name/description/parameters）只读文本。 */
	promptSnapshot: () => { full: string; texts: Record<string, string>; toolsSchema: string };
}

export class SettingsService {
	private settings: ClientSettings;
	private presets: SettingsPreset[];
	private knownSkills = new Map<string, UiSkillInfo>();
	private knownExtensions = new Map<string, UiExtensionInfo>();
	/** 流式中改了需要 reload 的设置 → agent_end 后延迟应用（防拆毁运行中 run）。 */
	private pendingReload = false;

	constructor(private readonly host: SettingsHost) {
		this.settings = host.stateStore.getSettings(host.clientId);
		this.presets = host.stateStore.getPresets(host.clientId);
	}

	get current(): ClientSettings {
		return this.settings;
	}

	hasPendingReload(): boolean {
		return this.pendingReload;
	}

	consumePendingReload(): boolean {
		const v = this.pendingReload;
		this.pendingReload = false;
		return v;
	}

	/** 判断某个 skill 名是否仍存在于磁盘任何来源（agent 区 / 项目 .pi / 祖先
	 *  .agents/skills / npm 包内 skills）。被禁用且文件已删除的名字不应再
	 *  出现在设置面板，也不应留在持久化记录里。 */
	private skillStillOnDisk(name: string): boolean {
		const cwd = this.host.cwd();
		const agentDir = this.host.agentDir();
		const check = (base: string) => existsSync(join(base, name)) || existsSync(join(base, `${name}.md`));
		// ① 用户区 <agentDir>/skills ② 项目 .pi/skills
		if (check(join(agentDir, "skills"))) return true;
		if (check(join(cwd, ".pi", "skills"))) return true;
		// ③ 祖先链 .agents/skills（SDK collectAncestorAgentsSkillDirs 语义，最多上溯 6 层）
		let dir: string = cwd;
		for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
			if (check(join(dir, ".agents", "skills"))) return true;
		}
		// ④ npm 包内 skills（agent 级 + 项目级，含 @scope 两级子包）
		for (const npmRoot of [join(agentDir, "npm", "node_modules"), join(cwd, ".pi", "npm", "node_modules")]) {
			try {
				for (const entry of readdirSync(npmRoot, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					if (!entry.name.startsWith("@")) {
						if (check(join(npmRoot, entry.name, "skills"))) return true;
					} else {
						for (const sub of readdirSync(join(npmRoot, entry.name), { withFileTypes: true })) {
							if (sub.isDirectory() && check(join(npmRoot, entry.name, sub.name, "skills"))) {
								return true;
							}
						}
					}
				}
			} catch {
				// npm 目录不存在/不可读 → 不是来源
			}
		}
		return false;
	}

	push(): void {
		const disabledSkills = new Set(this.settings.disabledSkills);
		const disabledExts = new Set(this.settings.disabledExtensions);
		let loadedSkillNames: Set<string> | null = null;
		try {
			const loadedSkills = this.host.getSession().resourceLoader.getSkills().skills;
			const loadedExts = this.host.getSession().resourceLoader.getExtensions().extensions;
			loadedSkillNames = new Set(loadedSkills.map((s) => s.name));
			// Prune entries that no longer exist on disk AND aren't disabled
			// (e.g. a skill/extension file was deleted). Disabled entries are
			// kept so they can be re-enabled even when filtered out of the loader.
			const keepSkills = new Set<string>([...loadedSkills.map((s) => s.name), ...this.settings.disabledSkills]);
			const keepExts = new Set<string>([
				...loadedExts.map((e) => extensionKey(e)),
				...this.settings.disabledExtensions,
			]);
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const name of [...this.knownSkills.keys()]) {
				if (!keepSkills.has(name)) this.knownSkills.delete(name);
			}
			// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
			for (const id of [...this.knownExtensions.keys()]) {
				if (!keepExts.has(id)) this.knownExtensions.delete(id);
			}
			for (const s of loadedSkills) {
				this.knownSkills.set(s.name, {
					name: s.name,
					description: s.description,
					enabled: true,
				});
			}
			for (const e of loadedExts) {
				const id = extensionKey(e);
				const p = e.sourceInfo?.path ?? e.path;
				this.knownExtensions.set(id, {
					id,
					name: e.sourceInfo?.origin === "package" && e.sourceInfo.source ? e.sourceInfo.source : basename(p),
					path: p,
					enabled: true,
				});
			}
		} catch {
			// Session not ready yet — keep whatever we already know.
		}
		// 清理“源文件已删除”的禁用残留记录：磁盘上已不存在的技能名从
		// disabledSkills / reviewDisabledSkills 持久化记录中移除——否则每次
		// 推送都会把已删除的 skill 以灰条形式永恒地补回面板（“关闭过的
		// skill 被一直记录”）。session 未就绪时保守跳过。
		if (loadedSkillNames !== null) {
			const stale = [
				...new Set([...this.settings.disabledSkills, ...normalizeSkillList(this.settings.skillsFullText)]),
			].filter((name) => !loadedSkillNames!.has(name) && !this.skillStillOnDisk(name));
			if (stale.length > 0) {
				this.settings.disabledSkills = this.settings.disabledSkills.filter((n) => !stale.includes(n));
				this.settings.skillsFullText = normalizeSkillList(this.settings.skillsFullText).filter(
					(n) => !stale.includes(n),
				);
				this.host.stateStore.saveSettings(this.host.clientId, {
					disabledSkills: this.settings.disabledSkills,
					skillsFullText: this.settings.skillsFullText,
				});
			}
		}
		// Disabled entries that still exist on disk are re-added (with the
		// last-known description) so they can be re-enabled; entries whose
		// source file was deleted are dropped instead of being resurrected.
		for (const name of this.settings.disabledSkills) {
			if (this.knownSkills.has(name)) continue;
			if (!this.skillStillOnDisk(name)) continue;
			this.knownSkills.set(name, { name, description: "", enabled: false });
		}
		for (const id of this.settings.disabledExtensions) {
			if (!this.knownExtensions.has(id)) {
				this.knownExtensions.set(id, {
					id,
					name: id.startsWith("npm:") ? id : basename(id),
					path: "",
					enabled: false,
				});
			}
		}
		const skills = [...this.knownSkills.values()]
			.map((s) => ({ ...s, enabled: !disabledSkills.has(s.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const extensions = [...this.knownExtensions.values()]
			.map((e) => ({ ...e, enabled: !disabledExts.has(e.id) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		// 统一工具开关是单源（disabledAgentTools），遗留三开关推送时推导，保证面板一致。
		const legacyTools = deriveLegacy(this.settings.disabledAgentTools ?? []);
		// 当前会话提示词快照：完整生效文本 + 各来源默认（自动）内容（只读预览）。
		const promptSnap = this.host.promptSnapshot();
		this.host.emit({
			type: "settings_state",
			settings: {
				promptMode: this.settings.promptMode,
				customSystemPrompt: this.settings.customSystemPrompt,
				promptTemplate: this.settings.promptTemplate ?? "",
				promptOverrides: { ...this.settings.promptOverrides },
				disabledAgentTools: [...normalizeDisabledAgentTools(this.settings.disabledAgentTools)],
				terminalToolsEnabled: legacyTools.terminalToolsEnabled,
				terminalBash: this.settings.terminalBash,
				terminalBashIdleMs: this.settings.terminalBashIdleMs,
				questionnaireEnabled: legacyTools.questionnaireEnabled,
				thinkingWrap: this.settings.thinkingWrap,
				toolsWrap: this.settings.toolsWrap,
				skillsFullText: [...normalizeSkillList(this.settings.skillsFullText)],
				// The composed system prompt actually in effect (read-only view).
				effectiveSystemPrompt: promptSnap.full,
				// 每个来源未覆盖时的默认（自动）内容（「各来源」行预览用）。
				promptSourceDefaults: promptSnap.texts,
				// 发给模型的工具 schema（name/description/parameters）—— 只读预览。
				toolsSchema: promptSnap.toolsSchema,
				disabledSkills: [...this.settings.disabledSkills],
				disabledExtensions: [...this.settings.disabledExtensions],
				skills,
				extensions,
				presets: this.presets.map((p) => ({ ...p })),
				retryMaxAttempts: this.settings.retryMaxAttempts,
			} satisfies UiSettingsState,
		});
	}

	/** Persist + apply a partial settings update (compose template / per-source
	 *  overrides, skill/extension toggles). */
	async set(partial: {
		promptMode?: PromptMode;
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		/** 统一工具禁用名单（单源；遗留三开关与之双向同步）。 */
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
		const needsReload =
			partial.promptMode !== undefined ||
			partial.customSystemPrompt !== undefined ||
			partial.promptTemplate !== undefined ||
			partial.promptOverrides !== undefined ||
			partial.disabledSkills !== undefined ||
			partial.disabledExtensions !== undefined;
		// 统一工具开关 live 生效（ActiveSet 加减，无需 reload），见末尾 applyToolGating。
		const toolGatingChanged =
			partial.disabledAgentTools !== undefined ||
			partial.terminalToolsEnabled !== undefined ||
			partial.questionnaireEnabled !== undefined;
		if (partial.promptMode !== undefined) this.settings.promptMode = partial.promptMode;
		if (partial.customSystemPrompt !== undefined) {
			this.settings.customSystemPrompt = partial.customSystemPrompt;
		}
		if (partial.promptTemplate !== undefined) {
			this.settings.promptTemplate = partial.promptTemplate;
		}
		if (partial.promptOverrides !== undefined) {
			// 只合并给出的 key；空串 = 清除该来源覆盖。
			const next = { ...this.settings.promptOverrides };
			for (const [k, v] of Object.entries(partial.promptOverrides)) {
				if (v && v.trim()) next[k] = v;
				else delete next[k];
			}
			this.settings.promptOverrides = next;
		}
		if (partial.disabledSkills !== undefined) {
			this.settings.disabledSkills = partial.disabledSkills;
		}
		if (partial.disabledExtensions !== undefined) {
			this.settings.disabledExtensions = partial.disabledExtensions;
		}
		// 统一工具开关：新字段优先；只给遗留单开关时折回新字段。两边写完再由
		// deriveLegacy 回填遗留别名，保证内存/推送/落盘三处一致。
		if (partial.disabledAgentTools !== undefined) {
			this.settings.disabledAgentTools = normalizeDisabledAgentTools(partial.disabledAgentTools);
		}
		if (partial.terminalToolsEnabled !== undefined || partial.questionnaireEnabled !== undefined) {
			this.settings.disabledAgentTools = foldLegacyIntoDisabled(this.settings.disabledAgentTools ?? [], {
				terminalToolsEnabled: partial.terminalToolsEnabled,
				questionnaireEnabled: partial.questionnaireEnabled,
			});
		}
		{
			const legacy = deriveLegacy(this.settings.disabledAgentTools ?? []);
			this.settings.terminalToolsEnabled = legacy.terminalToolsEnabled;
			this.settings.questionnaireEnabled = legacy.questionnaireEnabled;
		}
		if (partial.terminalBash !== undefined) {
			this.settings.terminalBash = partial.terminalBash;
		}
		if (partial.terminalBashIdleMs !== undefined) {
			this.settings.terminalBashIdleMs = Math.max(0, Math.floor(partial.terminalBashIdleMs) || 0);
		}
		if (partial.thinkingWrap !== undefined) {
			this.settings.thinkingWrap = partial.thinkingWrap;
		}
		if (partial.toolsWrap !== undefined) {
			this.settings.toolsWrap = partial.toolsWrap;
		}
		// 编排模式 / skill 全文注入：before_agent_start 逐 run 实时读取（agent-service
		// composeInputs + 指导块追加），开关下一轮即生效，无需 reload runtime。
		if (partial.skillsFullText !== undefined) {
			this.settings.skillsFullText = normalizeSkillList(partial.skillsFullText);
		}
		if (partial.retryMaxAttempts !== undefined) {
			// 出错重试次数：持久化 + 即时注入各会话（SDK 在每次退避前都重读
			// getRetrySettings，无需 reload runtime；见宿主 applyRetryOverrides）。
			this.settings.retryMaxAttempts = normalizeRetryMaxAttempts(partial.retryMaxAttempts);
			this.host.applyRetryOverrides();
		}
		this.host.stateStore.saveSettings(this.host.clientId, this.settings);
		this.push();
		// 统一工具开关 live 生效（ActiveSet 加减；失败静默，下次创建/reload 重放）。
		if (toolGatingChanged) this.host.applyToolGating();
		if (needsReload) await this.applyRuntime();
	}

	/** Save the CURRENT settings as a named preset (overwrites if exists). */
	async savePreset(name: string): Promise<void> {
		const n = name.trim();
		if (!n) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "Preset name cannot be empty",
			});
			return;
		}
		const preset = {
			name: n,
			promptMode: this.settings.promptMode,
			customSystemPrompt: this.settings.customSystemPrompt,
			promptTemplate: this.settings.promptTemplate ?? "",
			promptOverrides: { ...this.settings.promptOverrides },
			disabledSkills: [...this.settings.disabledSkills],
			disabledExtensions: [...this.settings.disabledExtensions],
			disabledAgentTools: [...normalizeDisabledAgentTools(this.settings.disabledAgentTools)],
			terminalToolsEnabled: this.settings.terminalToolsEnabled,
			terminalBash: this.settings.terminalBash,
			terminalBashIdleMs: this.settings.terminalBashIdleMs,
			retryMaxAttempts: this.settings.retryMaxAttempts,
			skillsFullText: [...normalizeSkillList(this.settings.skillsFullText)],
		};
		const existing = this.presets.findIndex((p) => p.name === n);
		if (existing >= 0) this.presets[existing] = preset;
		else this.presets.push(preset);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	/** Replace the current settings with the named preset and apply it. */
	async applyPreset(name: string): Promise<void> {
		const p = this.presets.find((x) => x.name === name);
		if (!p) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Preset does not exist: ${name}`,
			});
			return;
		}
		// 统一工具开关随预设走；旧预设缺新字段时按遗留两开关折算（问卷不进预设，
		// 从当前禁用名单继承，即保留当前问卷状态）。
		const presetDisabled = normalizeDisabledAgentTools(
			(p as { disabledAgentTools?: unknown }).disabledAgentTools ??
				foldLegacyIntoDisabled(this.settings.disabledAgentTools ?? [], {
					terminalToolsEnabled: p.terminalToolsEnabled,
				}),
		);
		const presetLegacy = deriveLegacy(presetDisabled);
		this.settings = {
			promptMode: p.promptMode,
			customSystemPrompt: p.customSystemPrompt,
			promptTemplate: p.promptTemplate ?? this.settings.promptTemplate ?? "",
			promptOverrides: { ...(p.promptOverrides ?? this.settings.promptOverrides) },
			disabledSkills: [...p.disabledSkills],
			disabledExtensions: [...p.disabledExtensions],
			disabledAgentTools: presetDisabled,
			terminalToolsEnabled: presetLegacy.terminalToolsEnabled,
			// 终端接管偏好随预设走；旧预设缺字段时保留当前值。
			terminalBash: p.terminalBash ?? this.settings.terminalBash,
			terminalBashIdleMs: p.terminalBashIdleMs ?? this.settings.terminalBashIdleMs,
			// 重试次数随预设走；旧预设缺字段时保留当前值，应用后即时注入各会话。
			retryMaxAttempts: p.retryMaxAttempts ?? this.settings.retryMaxAttempts,
			// 问卷开关不进预设——保留当前值。
			questionnaireEnabled: this.settings.questionnaireEnabled,
			// 全文注入名单随预设走；旧预设缺字段时保留当前值。
			skillsFullText: normalizeSkillList(p.skillsFullText ?? this.settings.skillsFullText),
			// 纯 UI 偏好不进预设——保留当前值。
			thinkingWrap: this.settings.thinkingWrap,
			toolsWrap: this.settings.toolsWrap,
		};
		this.host.stateStore.saveSettings(this.host.clientId, this.settings);
		// 预设可能改了重试次数：即时注入（流式中延迟的 reload 之后还会由调用方重放）。
		this.host.applyRetryOverrides();
		this.push();
		// 预设带了工具开关：live 应用（reload 路径会重放，流式中延迟到 agent_end）。
		this.host.applyToolGating();
		await this.applyRuntime();
	}

	/** Remove a named preset. */
	async deletePreset(name: string): Promise<void> {
		this.presets = this.presets.filter((p) => p.name !== name);
		this.host.stateStore.savePresets(this.host.clientId, this.presets);
		this.push();
	}

	/**
	 * Make settings changes effective in the running runtime. The resource-loader
	 * overrides read this.settings at call time, so a reload re-applies them.
	 * Reloading mid-stream would tear down the in-flight run — defer instead.
	 */
	async applyRuntime(): Promise<void> {
		if (this.host.isDisposed()) return;
		if (this.host.isStreaming()) {
			this.pendingReload = true;
			this.host.emit({
				type: "notice",
				level: "info",
				text: "A reply is in progress; settings will apply when it finishes",
			});
			return;
		}
		await this.applyReload();
	}

	/** session.reload() + refresh the slash-command catalog + push state. */
	private async applyReload(): Promise<void> {
		try {
			await this.host.reloadSession();
			this.push();
			this.host.flushSnapshot();
			this.host.emit({ type: "notice", level: "info", text: "Settings applied" });
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `Failed to apply settings: ${(err as Error).message}`,
			});
		}
	}
}

type SettingsPreset = ReturnType<ClientStateStore["getPresets"]>[number];
