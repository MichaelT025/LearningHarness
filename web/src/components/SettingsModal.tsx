import { useEffect, useRef, useState } from "react";
import {
	FiArchive,
	FiClock,
	FiCpu,
	FiFileText,
	FiMessageSquare,
	FiPackage,
	FiPlus,
	FiSettings,
	FiSliders,
	FiTool,
	FiTrash2,
	FiX,
	FiZap,
} from "react-icons/fi";
import { CopyButton } from "./copy-button";
import { HintTip } from "./HintTip";
import { NotifyToggle } from "./NotifyToggle";
import type { CommandDef, UiExtensionInfo, UiSettingsState, UiSkillInfo } from "../types";
import {
	clearPromptHistory,
	loadPromptHistory,
	loadPromptHistorySettings,
	savePromptHistorySettings,
} from "../prompt-history";
import { randomUuid } from "../uuid";
import { useWideChat, saveChatWidthSettings } from "../chat-width-settings";
import { useProjectTitle, saveTitleSettings } from "../title-settings";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { DEFAULT_PROMPT_TEMPLATE, PROMPT_TOKENS, isReadonlyPromptSource } from "../../../server/prompt-composer.js";
import { ASK_USER_QUESTION_TOOL_NAME, TERMINAL_TOOL_NAMES } from "../../../server/tool-manager.js";

/** Minimal terminal-tab bridge (same shape SCMPanel uses). */
interface SettingsTerminalBridge {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

interface SettingsModalProps {
	chat: {
		settings: UiSettingsState | null;
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		state?: { cwd: string; conversationId: string } | null;
		activeConversationId?: string | null;
	};
	terminal: SettingsTerminalBridge;
	/** Switch the top-level view to the terminal (uninstall runs there). */
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

/** 各来源排序权重：append 置顶（最常用），可编辑居中，只读沉底（纯预览）。 */
function rankPromptToken(tk: string): number {
	if (tk === "append") return 0;
	return isReadonlyPromptSource(tk) ? 2 : 1;
}

function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
}: {
	title: string;
	subtitle?: string;
	/** 长解释走「？」悬浮提示，不再平铺（subtitle 与 tip 二选一）。 */
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

/** 设置弹窗的左侧分组导航（一次只显示一个区块，消灭长滚动）。 */
type SettingsTab = "prompt" | "prompt-history" | "tools" | "display" | "skills" | "extensions" | "presets";

export function SettingsModal({ chat, terminal, onSwitchToTerminal, onClose }: SettingsModalProps) {
	const t = useT();
	// {{token}} 元数据文案键是动态的（promptTok_<token>[,_desc]），用 tt 跳过字面量类型。
	const tt = (k: string) => t(k as Parameters<typeof t>[0]);
	const settings = chat.settings;
	// 当前左侧导航选中的分组。
	const [tab, setTab] = useState<SettingsTab>("prompt");
	// 内容滚动容器：切换分组后回到顶部（各组高度不同，停留旧滚动位置会像没切换）。
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bodyRef.current?.scrollTo({ top: 0 });
	}, [tab]);
	// Compose prompt — 组合模板（{{token}} 自由拼装）+ 各来源覆盖。本地草稿：
	// 模板聚焦中不覆盖；某个来源的覆盖框聚焦中不覆盖该 key（防回显打断输入）。
	const [promptTemplateDraft, setPromptTemplateDraft] = useState("");
	const [promptOverridesDraft, setPromptOverridesDraft] = useState<Record<string, string>>({});
	const templateFocus = useRef(false);
	const overrideFocus = useRef<string | null>(null);
	// 各来源展示顺序：append 置顶，其次可编辑来源，只读来源沉底（组内保持 PROMPT_TOKENS 原序）。
	const orderedPromptTokens = [...PROMPT_TOKENS].sort((a, b) => rankPromptToken(a) - rankPromptToken(b));
	// 未覆盖来源行内默认内容预览：点击预览进入覆盖输入（editingSource）；长文本展开/收起。
	const [editingSource, setEditingSource] = useState<string | null>(null);
	const [defaultOpen, setDefaultOpen] = useState<Record<string, boolean>>({});
	const [presetName, setPresetName] = useState("");
	// Read-only viewer for the FULL system prompt actually in effect.
	const [showFullPrompt, setShowFullPrompt] = useState(false);
	const [showToolsSchema, setShowToolsSchema] = useState(false);
	// 宽屏聊天列开关（纯前端 localStorage，见 chat-width-settings.ts）。
	const wideChat = useWideChat();
	const projectTitle = useProjectTitle();
	// Prompt history settings (纯前端 localStorage，不经过 server).
	const [phSettings, setPhSettings] = useState(() => loadPromptHistorySettings());
	const [phCount, setPhCount] = useState(() => {
		try {
			return loadPromptHistory().length;
		} catch {
			return 0;
		}
	});
	const [phClearConfirm, setPhClearConfirm] = useState(false);
	const refreshPhCount = () => {
		try {
			setPhCount(loadPromptHistory().length);
		} catch {
			setPhCount(0);
		}
	};
	useEffect(() => {
		if (tab === "prompt-history") refreshPhCount();
	}, [tab]);
	useEffect(() => {
		if (!phClearConfirm) return;
		const id = window.setTimeout(() => setPhClearConfirm(false), 3000);
		return () => window.clearTimeout(id);
	}, [phClearConfirm]);
	// Two-step uninstall confirm: which extension id is awaiting confirmation.
	const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

	useEffect(() => {
		if (!settings) return;
		if (!templateFocus.current) setPromptTemplateDraft(settings.promptTemplate ?? "");
		setPromptOverridesDraft((prev) => {
			const next: Record<string, string> = {};
			for (const [k, v] of Object.entries(settings.promptOverrides ?? {})) next[k] = v ?? "";
			if (overrideFocus.current) next[overrideFocus.current] = prev[overrideFocus.current] ?? "";
			return next;
		});
	}, [settings]);

	const [idleMsDraft, setIdleMsDraft] = useState<string>(String(settings?.terminalBashIdleMs ?? 15000));
	useEffect(() => {
		setIdleMsDraft(String(settings?.terminalBashIdleMs ?? 15000));
	}, [settings?.terminalBashIdleMs]);
	// 模型报错自动重试次数：本地草稿（失焦/回车提交，0 = 失败即停）。
	const [retryDraft, setRetryDraft] = useState<string>(String(settings?.retryMaxAttempts ?? 6));
	useEffect(() => {
		setRetryDraft(String(settings?.retryMaxAttempts ?? 6));
	}, [settings?.retryMaxAttempts]);

	if (!settings) return null;

	// 统一工具禁用名单（工具 tab 唯一写入口；旧 tab 的遗留单开关已迁入）。
	const disabledTools = new Set(settings.disabledAgentTools ?? []);
	const disabledToolsCount = disabledTools.size;
	const tabs: {
		id: SettingsTab;
		icon: React.ReactNode;
		label: string;
		/** 有计数徽标（与各区块标题里的 set-count 同源）。 */
		count?: number;
	}[] = [
		{ id: "prompt", icon: <FiFileText />, label: t("settingsSystemPrompt") },
		{
			id: "prompt-history",
			icon: <FiClock />,
			label: t("settingsPromptHistory"),
			count: phCount,
		},
		{ id: "tools", icon: <FiTool />, label: t("settingsTools"), count: disabledToolsCount || undefined },
		{ id: "display", icon: <FiMessageSquare />, label: t("settingsMessageDisplay") },
		{ id: "skills", icon: <FiCpu />, label: t("settingsSkills"), count: settings.skills.length },
		{ id: "extensions", icon: <FiPackage />, label: t("settingsExtensions"), count: settings.extensions.length },
		{ id: "presets", icon: <FiSliders />, label: t("settingsPresets"), count: settings.presets.length },
	];

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		/** Unified disabled-tool list (per-tool switches on the Tools tab). */
		disabledAgentTools?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		questionnaireEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		skillsFullText?: string[];
		retryMaxAttempts?: number;
	}) => appSend({ type: "set_settings", ...patch });

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	// skill 全文注入名单：按技能单独勾选（空 = 名录模式）。
	const fullTextSkills = new Set(settings.skillsFullText ?? []);
	const toggleSkillFullText = (name: string) => {
		const next = new Set(fullTextSkills);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ skillsFullText: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	// 统一工具开关（工具 tab 逐工具；与 toggleSkill 同模式）。
	const toggleAgentTool = (name: string) => {
		const next = new Set(disabledTools);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ disabledAgentTools: [...next] });
	};

	/** Run a maintenance command (extension uninstall) in a VISIBLE terminal
	 *  tab (same reuse pattern as SCM write ops) so the user sees exactly what
	 *  happened. On exit the App watcher sends extensions_reload. */
	const runTerminalCommand = (title: string, command: string) => {
		const cmd: CommandDef = {
			name: title,
			command,
			cwd: "${pwd}",
		};
		let targetId: string;
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			targetId = existing.id;
		} else {
			targetId = randomUuid();
			terminal.create({
				id: targetId,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		terminal.select(targetId);
		onSwitchToTerminal();
		onClose();
	};

	/** Uninstall a `pi install`-ed package: run `pi remove npm:<pkg>` in a
	 *  visible terminal tab (see runTerminalCommand). */
	const runUninstall = (pkgName: string) => {
		setConfirmUninstall(null);
		runTerminalCommand(`${t("uninstallTitle")} ${pkgName}`, `pi remove npm:${pkgName}`);
	};

	const commitTemplate = () => setPartial({ promptTemplate: promptTemplateDraft });

	const commitOverride = (token: string) => {
		setPartial({ promptOverrides: { [token]: promptOverridesDraft[token] ?? "" } });
	};

	const resetOverride = (token: string) => {
		if (overrideFocus.current === token) overrideFocus.current = null;
		setEditingSource(null);
		setPromptOverridesDraft((p) => {
			const n = { ...p };
			delete n[token];
			return n;
		});
		setPartial({ promptOverrides: { [token]: "" } });
	};

	/** 来源默认内容预览的长文本展开/收起。 */
	const toggleDefault = (tk: string) => setDefaultOpen((p) => ({ ...p, [tk]: !p[tk] }));

	/** 覆盖输入时一键把默认（自动）内容填进覆盖框 —— 只想改一小部分时用它打底（填
	 *  入后该来源内容固定，不再随每次对话自动重新生成）。 */
	const seedFromDefault = (tk: string, def: string) => {
		setPromptOverridesDraft((p) => ({ ...p, [tk]: def }));
		setEditingSource(tk);
	};

	const resetAllPrompt = () => {
		templateFocus.current = false;
		overrideFocus.current = null;
		setPromptTemplateDraft(DEFAULT_PROMPT_TEMPLATE);
		setPromptOverridesDraft({});
		setPartial({ promptTemplate: DEFAULT_PROMPT_TEMPLATE, promptOverrides: {} });
	};

	const appendTokenToTemplate = (token: string) => {
		setPromptTemplateDraft((prev) => (prev.trim() ? `${prev}\n\n{{${token}}}` : `{{${token}}}`));
	};

	const hasPromptCustom =
		(promptTemplateDraft.trim() && promptTemplateDraft.trim() !== DEFAULT_PROMPT_TEMPLATE) ||
		Object.values(promptOverridesDraft).some((v) => v.trim());

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
					{/* 长说明收起为「？」悬浮提示，不再平铺占版面 */}
					<HintTip text={t("settingsDesc")} />
				</div>

				{/* Scrollable body — head above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="settings-layout">
					<nav className="settings-rail" aria-label={t("settingsTitle")}>
						{tabs.map((tb) => (
							<button
								key={tb.id}
								type="button"
								className={`settings-tab${tab === tb.id ? " active" : ""}`}
								aria-current={tab === tb.id ? "true" : undefined}
								title={tb.label}
								onClick={() => setTab(tb.id)}
							>
								<span className="settings-tab-icon">{tb.icon}</span>
								<span className="settings-tab-label">{tb.label}</span>
								{tb.count !== undefined && <span className="set-count">{tb.count}</span>}
							</button>
						))}
					</nav>
					<div className="modal-body" ref={bodyRef}>
						{/* ---- system prompt -------------------------------------------- */}
						{tab === "prompt" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsSystemPrompt")}
									<HintTip text={`${t("promptComposeHint")}\n${t("promptComposeDesc")}`} />
								</div>
								<div className="set-field">
									<label className="set-field-label">{t("promptTemplateLabel")}</label>
									<textarea
										className="set-prompt-input"
										rows={8}
										spellCheck={false}
										placeholder={DEFAULT_PROMPT_TEMPLATE}
										value={promptTemplateDraft}
										onFocus={() => (templateFocus.current = true)}
										onBlur={() => {
											templateFocus.current = false;
											commitTemplate();
										}}
										onChange={(e) => setPromptTemplateDraft(e.target.value)}
									/>
									<div className="compose-toolbar">
										<span className="set-field-label set-muted">{t("promptInsertTokens")}</span>
										{orderedPromptTokens.map((tk) => (
											<button
												key={tk}
												type="button"
												className="token-chip"
												title={tt(`promptTok_${tk}_desc`)}
												onClick={() => appendTokenToTemplate(tk)}
											>
												{`{{${tk}}}`}
											</button>
										))}
									</div>
								</div>
								{/* 各来源覆盖：留空 = 用自动内容；未覆盖时行内直接展示该来源当前的默认（自动）内容 */}
								<div className="set-field">
									<label className="set-field-label">{t("promptSourcesLabel")}</label>
									{orderedPromptTokens.map((tk) => {
										const v = promptOverridesDraft[tk] ?? "";
										// 该来源当前默认（自动）内容：会话未就绪时为空对象 → def = ""。
										const def = settings.promptSourceDefaults?.[tk] ?? "";
										const editing = editingSource === tk;
										const isLong = def.split("\n").length > 6 || def.length > 480;
										if (isReadonlyPromptSource(tk)) {
											const shown = v.trim() ? v : def;
											return (
												<div className="override-row readonly" key={tk}>
													<div className="override-row-head">
														{`{{${tk}}}`}
														<span className="set-muted">
															{tt(`promptTok_${tk}`)} <HintTip text={tt(`promptTok_${tk}_desc`)} />
														</span>
														{v.trim() ? (
															<button
																type="button"
																className="set-btn-mini"
																title={t("promptReadonlyLockedHint")}
																onClick={() => resetOverride(tk)}
															>
																{t("promptResetSource")}
															</button>
														) : (
															<span className="set-muted">{t("promptReadonlyBadge")}</span>
														)}
													</div>
													<div
														className={`source-default readonly${shown.trim() ? "" : " empty"}`}
														title={t("promptReadonlyTitle")}
													>
														{shown.trim() ? (
															<>
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{shown}
																</pre>
																{isLong && (
																	<span
																		className="source-default-toggle"
																		role="button"
																		tabIndex={0}
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleDefault(tk);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				toggleDefault(tk);
																			}
																		}}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</span>
																)}
															</>
														) : (
															<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
														)}
													</div>
												</div>
											);
										}
										return (
											<div className="override-row" key={tk}>
												<div className="override-row-head">
													{`{{${tk}}}`}
													<span className="set-muted">
														{tt(`promptTok_${tk}`)} <HintTip text={tt(`promptTok_${tk}_desc`)} />
													</span>
													{v.trim() ? (
														<button type="button" className="set-btn-mini" onClick={() => resetOverride(tk)}>
															{t("promptResetSource")}
														</button>
													) : (
														<span className="set-muted">{t("promptAutoBadge")}</span>
													)}
												</div>
												{v.trim() || editing ? (
													<>
														<textarea
															className="set-prompt-input override-input"
															rows={Math.min(10, Math.max(1, v.split("\n").length))}
															autoFocus={editing}
															placeholder={t("promptOverridePlaceholder")}
															value={v}
															onFocus={(e) => {
																overrideFocus.current = tk;
																setEditingSource(tk);
																// 刚点预览载入默认文本时把光标放到末尾，方便直接接着改。
																const el = e.currentTarget as HTMLTextAreaElement;
																if (el.value && el.value === def)
																	el.setSelectionRange(el.value.length, el.value.length);
															}}
															onBlur={() => {
																if (overrideFocus.current === tk) overrideFocus.current = null;
																const val = promptOverridesDraft[tk] ?? "";
																if (val.trim() && val === def) {
																	// 点击预览载入默认后原样失焦（没改任何字）→ 不产生覆盖，仍用自动内容。
																	resetOverride(tk);
																	return;
																}
																commitOverride(tk);
																if (!val.trim()) setEditingSource(null);
															}}
															onChange={(e) => setPromptOverridesDraft((p) => ({ ...p, [tk]: e.target.value }))}
														/>
														{/* 编辑覆盖内容时，下方始终展示该来源的默认（自动）内容，方便对照/复制/只改一小部分。 */}
														<div className="override-edit-foot">
															<div className="override-edit-foot-head">
																<span className="set-muted">{t("promptSourceRefLabel")}</span>
																{isLong && (
																	<button
																		type="button"
																		className="source-default-toggle"
																		onClick={() => toggleDefault(tk)}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</button>
																)}
															</div>
															{def.trim() ? (
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{def}
																</pre>
															) : (
																<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
															)}
															{!v.trim() && def.trim() && (
																<button
																	type="button"
																	className="override-seed-btn"
																	title={t("promptSourceSeedTip")}
																	onClick={() => seedFromDefault(tk, def)}
																>
																	{t("promptSourceSeedButton")}
																</button>
															)}
														</div>
													</>
												) : (
													// 未覆盖：行内展示默认（自动）内容；点击 = 载入默认文本开始编辑（不改就失焦则回到自动内容）。
													<div
														className="source-default"
														title={t("promptSourceDefaultEditHint")}
														role="button"
														tabIndex={0}
														onClick={() => seedFromDefault(tk, def)}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																e.preventDefault();
																seedFromDefault(tk, def);
															}
														}}
													>
														{def.trim() ? (
															<>
																<pre
																	className={`source-default-text${
																		isLong ? (defaultOpen[tk] ? " expanded" : " clamped") : ""
																	}`}
																>
																	{def}
																</pre>
																{isLong && (
																	<span
																		className="source-default-toggle"
																		role="button"
																		tabIndex={0}
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleDefault(tk);
																		}}
																		onKeyDown={(e) => {
																			if (e.key === "Enter" || e.key === " ") {
																				e.preventDefault();
																				e.stopPropagation();
																				toggleDefault(tk);
																			}
																		}}
																	>
																		{defaultOpen[tk] ? t("promptSourceCollapse") : t("promptSourceExpand")}
																	</span>
																)}
															</>
														) : (
															<span className="source-default-empty">{t("promptSourceDefaultEmpty")}</span>
														)}
													</div>
												)}
											</div>
										);
									})}
									<div className="compose-toolbar">
										<button type="button" className="set-btn" onClick={resetAllPrompt} disabled={!hasPromptCustom}>
											{t("promptResetAll")}
										</button>
									</div>
								</div>
								<button
									type="button"
									className="set-view-prompt-btn"
									aria-expanded={showFullPrompt}
									onClick={() => setShowFullPrompt((v) => !v)}
								>
									{t("settingsViewPrompt")} {showFullPrompt ? "▴" : "▾"}
								</button>
								{showFullPrompt && (
									<div className="set-prompt-view">
										<div className="set-prompt-view-head">
											<span>{t("settingsViewPrompt")}</span>
											<HintTip text={t("settingsViewPromptHint")} />
											<CopyButton text={settings.effectiveSystemPrompt} />
										</div>
										{settings.effectiveSystemPrompt ? (
											<pre className="set-prompt-view-text">{settings.effectiveSystemPrompt}</pre>
										) : (
											<p className="set-empty">{t("settingsViewPromptEmpty")}</p>
										)}
									</div>
								)}
								<button
									type="button"
									className="set-view-prompt-btn"
									aria-expanded={showToolsSchema}
									onClick={() => setShowToolsSchema((v) => !v)}
								>
									{t("settingsViewToolsSchema")} {showToolsSchema ? "▴" : "▾"}
								</button>
								{showToolsSchema && (
									<div className="set-prompt-view">
										<div className="set-prompt-tools">
											<div className="set-prompt-view-head">
												<span>{t("settingsViewToolsSchema")}</span>
												<HintTip text={t("settingsViewToolsSchemaHint")} />
												<CopyButton text={settings.toolsSchema} />
											</div>
											{settings.toolsSchema ? (
												<pre className="set-prompt-view-text">{settings.toolsSchema}</pre>
											) : (
												<p className="set-empty">{t("settingsViewToolsSchemaEmpty")}</p>
											)}
										</div>
									</div>
								)}
							</div>
						)}

						{/* ---- prompt history -------------------------------------------- */}
						{tab === "prompt-history" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiClock className="set-section-icon" />
									{t("settingsPromptHistory")}
									<HintTip text={t("settingsPromptHistoryDesc")} />
									<span className="set-count">{t("promptHistoryCount", { n: String(phCount) })}</span>
								</div>
								{phCount === 0 ? (
									<p className="set-empty">{t("promptHistoryEmpty")}</p>
								) : (
									<p className="set-hint">{t("promptHistoryCount", { n: String(phCount) })}</p>
								)}
								<div className="set-field">
									<label className="set-field-label" htmlFor="ph-max">
										{t("promptHistoryMax")}
									</label>
									<div className="set-mode-row">
										<input
											id="ph-max"
											className="set-input"
											type="number"
											min={1}
											max={500}
											step={1}
											value={String(phSettings.maxEntries)}
											onChange={(e) => {
												const v = Math.floor(Number(e.target.value) || 0);
												const next = { ...phSettings, maxEntries: v };
												setPhSettings(next);
											}}
											onBlur={() => {
												const norm = { ...phSettings };
												if (!Number.isFinite(norm.maxEntries) || norm.maxEntries < 1) norm.maxEntries = 1;
												if (norm.maxEntries > 500) norm.maxEntries = 500;
												norm.maxEntries = Math.floor(norm.maxEntries);
												setPhSettings(norm);
												savePromptHistorySettings(norm);
												refreshPhCount();
											}}
										/>
										<HintTip text={t("promptHistoryMaxHint")} />
									</div>
								</div>
								<ToggleRow
									title={t("promptHistoryCharLimit")}
									tip={t("promptHistoryCharLimitHint")}
									enabled={phSettings.charLimitEnabled}
									onToggle={() => {
										const next = { ...phSettings, charLimitEnabled: !phSettings.charLimitEnabled };
										setPhSettings(next);
										savePromptHistorySettings(next);
										refreshPhCount();
									}}
								/>
								{phSettings.charLimitEnabled && (
									<div className="set-field">
										<label className="set-field-label" htmlFor="ph-char-limit">
											{t("promptHistoryCharLimit")}
										</label>
										<input
											id="ph-char-limit"
											className="set-input"
											type="number"
											min={100}
											max={20000}
											step={100}
											placeholder={t("promptHistoryCharLimitPlaceholder")}
											value={String(phSettings.charLimit)}
											onChange={(e) => {
												const v = Math.floor(Number(e.target.value) || 0);
												setPhSettings({ ...phSettings, charLimit: v });
											}}
											onBlur={() => {
												let v = Math.floor(Number(phSettings.charLimit) || 0);
												if (!Number.isFinite(v) || v < 100) v = 100;
												if (v > 20000) v = 20000;
												const norm = { ...phSettings, charLimit: v };
												setPhSettings(norm);
												savePromptHistorySettings(norm);
												refreshPhCount();
											}}
										/>
									</div>
								)}
								<div className="set-field" style={{ marginTop: 12 }}>
									<button
										type="button"
										className={`set-uninstall${phClearConfirm ? " confirm" : ""}`}
										disabled={phCount === 0}
										title={phCount === 0 ? t("promptHistoryEmpty") : t("promptHistoryClear")}
										onClick={() => {
											if (!phClearConfirm) {
												setPhClearConfirm(true);
												return;
											}
											clearPromptHistory();
											setPhClearConfirm(false);
											refreshPhCount();
										}}
									>
										<FiTrash2 /> {phClearConfirm ? t("promptHistoryClearConfirm") : t("promptHistoryClear")}
									</button>
									{phCount > 0 && (
										<span className="set-hint" style={{ marginLeft: 8 }}>
											{t("promptHistoryCount", { n: String(phCount) })}
										</span>
									)}
								</div>
								<p className="set-hint">
									<FiArchive style={{ verticalAlign: "-2px", marginRight: 4 }} />
									{t("settingsPromptHistoryDesc")}
								</p>
							</div>
						)}

						{/* ---- agent tools (unified tool_manage) ------------------------- */}
						{tab === "tools" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiTool className="set-section-icon" />
									{t("settingsTools")}
								</div>
								<div className="set-field-label">{t("toolsSectionTerminal")}</div>
								{TERMINAL_TOOL_NAMES.map((n) => (
									<ToggleRow
										key={n}
										title={n}
										tip={t("settingsTerminalToolsDesc")}
										enabled={!disabledTools.has(n)}
										onToggle={() => toggleAgentTool(n)}
									/>
								))}
								<ToggleRow
									title={t("terminalBashTakeover")}
									tip={t("terminalBashTakeoverDesc")}
									enabled={settings.terminalBash}
									onToggle={() => setPartial({ terminalBash: !settings.terminalBash })}
								/>
								{settings.terminalBash && (
									<div className="set-field">
										<label className="set-field-label" htmlFor="tb-idle-ms">
											{t("terminalBashIdleMs")}
										</label>
										<input
											id="tb-idle-ms"
											className="set-input"
											type="number"
											min={0}
											step={1000}
											value={idleMsDraft}
											onChange={(e) => setIdleMsDraft(e.target.value)}
											onBlur={() => {
												const n = Math.max(0, Math.floor(Number(idleMsDraft) || 0));
												setIdleMsDraft(String(n));
												if (n !== settings.terminalBashIdleMs) {
													setPartial({ terminalBashIdleMs: n });
												}
											}}
										/>
									</div>
								)}
								<ToggleRow
									title={ASK_USER_QUESTION_TOOL_NAME}
									tip={`${t("questionnaireEnabledDesc")}\n${t("questionnaireOffHint")}`}
									enabled={!disabledTools.has(ASK_USER_QUESTION_TOOL_NAME)}
									onToggle={() => toggleAgentTool(ASK_USER_QUESTION_TOOL_NAME)}
								/>
							</div>
						)}

						{/* ---- message display ----------------------------------------- */}
						{tab === "display" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiMessageSquare className="set-section-icon" />
									{t("settingsMessageDisplay")}
								</div>
								<div className="set-field">
									<label className="set-field-label" htmlFor="model-retry-max">
										{t("modelRetryAttempts")} <HintTip text={t("modelRetryHint")} />
									</label>
									<input
										id="model-retry-max"
										className="set-input"
										type="number"
										min={0}
										max={100}
										step={1}
										value={retryDraft}
										onChange={(e) => setRetryDraft(e.target.value)}
										onBlur={() => {
											const n = Math.min(100, Math.max(0, Math.floor(Number(retryDraft) || 0)));
											setRetryDraft(String(n));
											if (n !== settings.retryMaxAttempts) {
												setPartial({ retryMaxAttempts: n });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</div>
								<hr className="set-sep" />
								<ToggleRow
									title={t("thinkingWrap")}
									tip={t("thinkingWrapDesc")}
									enabled={settings.thinkingWrap ?? true}
									onToggle={() => setPartial({ thinkingWrap: !(settings.thinkingWrap ?? true) })}
								/>
								<ToggleRow
									title={t("toolsWrap")}
									tip={t("toolsWrapDesc")}
									enabled={settings.toolsWrap ?? false}
									onToggle={() => setPartial({ toolsWrap: !(settings.toolsWrap ?? false) })}
								/>
								<hr className="set-sep" />
								<ToggleRow
									title={t("wideChat")}
									tip={t("wideChatDesc")}
									enabled={wideChat}
									onToggle={() => saveChatWidthSettings({ wide: !wideChat })}
								/>
								<ToggleRow
									title={t("projectTitle")}
									tip={t("projectTitleDesc")}
									enabled={projectTitle}
									onToggle={() => saveTitleSettings({ projectName: !projectTitle })}
								/>
								<hr className="set-sep" />
								<NotifyToggle />
							</div>
						)}

						{/* ---- skills --------------------------------------------------- */}
						{tab === "skills" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiCpu className="set-section-icon" />
									{t("settingsSkills")}
									<HintTip text={`${t("skillFullTextLabel")}：${t("skillFullTextDesc")}`} />
									<span className="set-count">{settings.skills.length}</span>
								</div>
								{settings.skills.length === 0 ? (
									<p className="set-empty">{t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.skills.map((s) => (
											<ToggleRow
												key={s.name}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleSkill(s)}
												action={
													<button
														type="button"
														className={`tpl-chip${fullTextSkills.has(s.name) ? " on" : ""}`}
														title={t("skillFullTextDesc")}
														onClick={() => toggleSkillFullText(s.name)}
													>
														{t("skillFullTextShort")}
													</button>
												}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- extensions ------------------------------------------------ */}
						{tab === "extensions" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiPackage className="set-section-icon" />
									{t("settingsExtensions")}
									<span className="set-count">{settings.extensions.length}</span>
								</div>
								{settings.extensions.length === 0 ? (
									<p className="set-empty">{t("noExtensions")}</p>
								) : (
									<div className="set-list">
										{settings.extensions.map((e) => {
											const pkgName = e.id.startsWith("npm:") ? e.id.slice(4) : null;
											return (
												<ToggleRow
													key={e.id}
													title={e.name}
													subtitle={e.path}
													enabled={e.enabled}
													onToggle={() => toggleExtension(e)}
													action={
														pkgName ? (
															confirmUninstall === e.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("uninstallConfirmHint")}
																	onClick={() => runUninstall(pkgName)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("uninstallHint")}
																	onClick={() => setConfirmUninstall(e.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)
														) : undefined
													}
												/>
											);
										})}
									</div>
								)}
							</div>
						)}

						{tab === "presets" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSettings className="set-section-icon" />
									{t("settingsPresets")}
									<span className="set-count">{settings.presets.length}</span>
								</div>
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("presetNamePlaceholder")}
										value={presetName}
										onChange={(e) => setPresetName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && presetName.trim()) {
												appSend({ type: "save_preset", name: presetName.trim() });
												setPresetName("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!presetName.trim()}
										onClick={() => {
											appSend({ type: "save_preset", name: presetName.trim() });
											setPresetName("");
										}}
									>
										<FiPlus /> {t("saveAsPreset")}
									</button>
								</div>
								{settings.presets.length === 0 ? (
									<p className="set-empty">{t("noPresets")}</p>
								) : (
									<div className="set-list">
										{settings.presets.map((p) => (
											<div className="set-row" key={p.name}>
												<div className="set-row-info">
													<div className="set-row-name">{p.name}</div>
													<div className="set-row-desc">
														{p.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}
														{p.disabledSkills.length > 0 && ` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
														{p.disabledExtensions.length > 0 &&
															` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className="dd-refresh"
														onClick={() => appSend({ type: "apply_preset", name: p.name })}
													>
														{t("applyPreset")}
													</button>
													<button
														type="button"
														className="set-icon-btn danger"
														title={t("deletePreset")}
														onClick={() => appSend({ type: "delete_preset", name: p.name })}
													>
														<FiTrash2 />
													</button>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
