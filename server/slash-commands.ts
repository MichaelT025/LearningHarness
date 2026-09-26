/**
 * slash-commands — 斜杠命令目录与内置命令执行，从 agent-service.ts 抽出。
 *
 * 职责：
 *  - NATIVE_COMMANDS：web 服务端原生实现的斜杠命令清单（pi CLI 的交互式内置命令
 *    如 /model /new 不经 SDK prompt()——不拦截会被当普通文本发给模型）
 *  - push()：目录 = 内置命令 + 活动对话的扩展命令 / 提示模板 / 技能（与 SDK
 *    展开行为一致），推 slash_commands 供输入框选择器使用
 *  - exec()：拦截执行内置命令；返回 false 表示非内置命令，prompt 落到 SDK
 *
 * 经 SlashHost 窄接口与 ClientSession 解耦（同 settings-service/goal-service 模式）。
 * UI 文案直接中文（服务端 notice 约定）。/help 与 /copy 是纯客户端动作（不到服务端），
 * 保留在目录里供选择器展示，exec 里吞掉防止 SDK 当文本。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, SlashCommandInfo } from "./protocol.js";

/** ClientSession 提供给本服务的宿主能力（窄接口，便于独立测试）。 */
export interface SlashHost {
	emit: (msg: ServerMessage) => void;
	/** 当前工作目录（/cwd 无参数时回显）。 */
	cwd: () => string;
	/** 活动对话的 session。 */
	getSession: () => AgentSession;
	/** 新建/切到一个空白对话。返回 false = 没能进入新对话（准入关闭 / 同项目
	 *  对话数达上限 / runtime 创建失败）——此时 /new <prompt> 不能把首条提示发
	 *  出去，否则会落进用户原本正在用的那个对话。不返回（void）视为成功。 */
	newChat: () => Promise<void | boolean>;
	/** Send a prompt in the active conversation (used by /new <prompt>). */
	prompt?: (text: string) => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setCwd: (path: string) => Promise<void>;
	setThinking: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
	renameSession?: (name: string) => Promise<void> | void;
	refreshSessions: () => Promise<void>;
	/** supervisor 的优雅重启调度；返回 false 时 exec 兜底 process.exit(0)。 */
	onQuit?: () => boolean;
	/** session.reload() 之后的钩子（重放终端工具开关等设置门控）。 */
	afterReload?: () => void;
}

/** Slash commands implemented natively by the web server (the pi CLI's built-in
 * interactive commands like /model and /new are NOT handled by the SDK's
 * prompt() — without this they'd be sent to the model as plain text). Keep in
 * sync with exec(). */
export const NATIVE_COMMANDS: {
	name: string;
	description: string;
	argumentHint?: string;
}[] = [
	{
		name: "new",
		description: "New chat (optional first prompt: /new <prompt>)",
		argumentHint: "[prompt]",
	},
	{
		name: "name",
		description: "Set session display name",
		argumentHint: "<name>",
	},
	{
		name: "model",
		description: "Switch model",
		argumentHint: "[name]",
	},
	{
		name: "compact",
		description: "Compact context",
		argumentHint: "[instructions]",
	},
	{
		name: "cwd",
		description: "Switch workspace",
		argumentHint: "<path>",
	},
	{
		name: "thinking",
		description: "Set thinking level",
		argumentHint: "<off|low|medium|high|xhigh|max>",
	},
	{ name: "resume", description: "Refresh session list" },
	{ name: "reload", description: "Reload extensions, skills & templates" },
	{ name: "help", description: "Show all commands" },
	{ name: "copy", description: "Copy last assistant reply" },
	{ name: "pi-web-ui:quit", description: "Quit server (supervisor will restart)" },
];

/** Parse a prompt into "/command args" — returns null when it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
	if (!m || !m[1]) return null;
	return { name: m[1], args: m[2].trim() };
}

export class SlashCommandsService {
	constructor(private readonly host: SlashHost) {}

	/**
	 * Catalog of slash commands for the chat input: web-native builtins first,
	 * then the SDK's invokable commands for the ACTIVE conversation (extension
	 * commands, prompt templates, skills) — the same set the SDK expands when a
	 * prompt text starts with "/" (see AgentSession.prompt).
	 */
	async push(): Promise<void> {
		const commands: SlashCommandInfo[] = [];
		const seen = new Set<string>();
		for (const c of NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		try {
			const s = this.host.getSession();
			// Extension commands — the SDK already suffixes collisions with builtin
			// names ("new:2"), and those still reach the SDK since exec() only
			// intercepts the exact native names.
			for (const cmd of s.extensionRunner.getRegisteredCommands()) {
				if (seen.has(cmd.invocationName)) continue;
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
				});
				seen.add(cmd.invocationName);
			}
			// Prompt templates: /templatename args
			for (const t of s.promptTemplates) {
				if (seen.has(t.name)) continue;
				commands.push({
					name: t.name,
					description: t.description,
					source: "prompt",
				});
				seen.add(t.name);
			}
			// Skills: /skill:name args
			for (const skill of s.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				if (seen.has(name)) continue;
				commands.push({
					name,
					description: skill.description,
					source: "skill",
				});
				seen.add(name);
			}
		} catch {
			// Session not ready yet — native-only catalog still serves the picker.
		}
		this.host.emit({ type: "slash_commands", commands });
	}

	/** Run a native slash command (see NATIVE_COMMANDS). Returns false when the
	 *  name is not a native command (the prompt falls through to the SDK). */
	async exec(name: string, args: string): Promise<boolean> {
		switch (name) {
			case "new": {
				const first = args.trim();
				const ready = await this.host.newChat();
				// /new <prompt>: deliver the text as the new session's first
				// prompt, exactly as if typed after the switch. Empty = old
				// behavior (blank chat, no send). Only when the switch actually
				// landed on a blank chat — newChat() reports false when it bailed
				// (cap reached / runtime creation failed) and sending anyway would
				// drop the text into the conversation the user was already in.
				if (ready !== false && first && this.host.prompt) await this.host.prompt(first);
				return true;
			}
			case "name": {
				const trimmed = args.trim();
				if (!trimmed) {
					const current = this.host.getSession().sessionName;
					this.host.emit({
						type: "notice",
						level: "info",
						text: current ? `Current session name: ${current}. Usage: /name <name>` : `Usage: /name <name>`,
					});
					return true;
				}
				if (this.host.renameSession) {
					await this.host.renameSession(trimmed);
				} else {
					this.host.getSession().setSessionName(trimmed);
					await this.host.refreshSessions();
					this.host.emit({
						type: "notice",
						level: "info",
						text: `Renamed current session to "${trimmed}"`,
					});
				}
				return true;
			}
			case "model": {
				if (!args) {
					const current = this.host.getSession().model;
					this.host.emit({
						type: "notice",
						level: "info",
						text: current
							? `Current model: ${current.name} (${current.provider}/${current.id}). Usage: /model <name>`
							: `Usage: /model <name>`,
					});
					return true;
				}
				const query = args.toLowerCase();
				const available = await this.host.getSession().modelRuntime.getAvailable();
				// Prefer an exact "provider/id" match, else id/name substring.
				const exact = available.find((m) => m.provider + "/" + m.id === args.trim());
				const matches = exact
					? [exact]
					: available.filter(
							(m) =>
								m.id.toLowerCase().includes(query) ||
								m.name.toLowerCase().includes(query) ||
								m.provider.toLowerCase().includes(query),
						);
				if (matches.length === 0) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `No matching model: ${args} (see the model list in the top bar)`,
					});
					return true;
				}
				const pick = matches[0];
				if (matches.length > 1) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `Found ${matches.length} matching models, using: ${pick.name} (use provider/id for an exact match)`,
					});
				}
				await this.host.setModel(`${pick.provider}/${pick.id}`);
				return true;
			}
			case "compact":
				try {
					await this.host.getSession().compact(args || undefined);
				} catch {
					// 压缩过程/结果/错误反馈统一由 agent-service onEvent 的
					// compaction_start / compaction_end 事件处理（含 errorMessage），
					// 这里不重复发通知；SDK 在 throw 前必发 compaction_end（issue #33）。
				}
				return true;
			case "cwd":
				if (!args) {
					this.host.emit({
						type: "notice",
						level: "info",
						text: `Current directory: ${this.host.cwd()}. Usage: /cwd <path>`,
					});
				} else {
					await this.host.setCwd(args);
				}
				return true;
			case "thinking": {
				const ALIAS: Record<string, string> = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				const level = ALIAS[args.trim().toLowerCase()];
				if (!level) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `Invalid thinking level: ${args || "(empty)"}. Available: off / minimal / low / medium / high / xhigh / max`,
					});
					return true;
				}
				this.host.setThinking(level as Parameters<SlashHost["setThinking"]>[0]);
				return true;
			}
			case "resume":
				await this.host.refreshSessions();
				this.host.emit({
					type: "notice",
					level: "info",
					text: "Session list refreshed — pick one under History on the left",
				});
				return true;
			case "reload":
				try {
					// Re-discovers extensions / skills / prompt templates from disk and
					// re-pushes the picker catalog (the CLI's /reload semantics).
					await this.host.getSession().reload();
					// reload() 会把 custom 工具加回活跃集——重放设置门控（终端开关等）。
					this.host.afterReload?.();
					await this.push();
					this.host.emit({
						type: "notice",
						level: "info",
						text: "Reloaded extensions, skills and prompt templates",
					});
				} catch (err) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `Reload failed: ${(err as Error).message}`,
					});
				}
				return true;
			case "pi-web-ui:quit": {
				this.host.emit({
					type: "notice",
					level: "info",
					text: "Quitting pi-web-ui… the supervisor will restart the service",
				});
				setTimeout(() => {
					const didSchedule = this.host.onQuit?.() ?? false;
					if (!didSchedule) {
						setTimeout(() => process.exit(0), 100);
					}
				}, 300);
				return true;
			}
			case "help":
			case "copy":
				// Client-side UI actions — the client handles them before sending;
				// swallow here so the SDK never sees them as plain prompt text.
				return true;
			default:
				return false;
		}
	}
}
