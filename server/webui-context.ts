/**
 * webui-context — 扩展 UI 桥：把扩展的 setWidget/setStatus/notify/select/
 * confirm/input 等调用桥接到浏览器（widgets/statuses/notice/dialog 消息）。
 * TUI 专属能力（终端输入、footer/header、自定义组件）为惰性 no-op；
 * select/confirm/input 弹窗经 dialog_response 回传，Esc 视为取消。
 *
 * 从 agent-service.ts 抽出，行为保持不变。
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";
import { TODO_WIDGET_KEY } from "./todo-state.js";

const WIDGET_WIDTH = 80;

/** ANSI 转义序列（CSI + OSC 两类）：扩展 widget/status 文本里常混有 TUI 颜色码
 *  （如 pi-powerline-footer），浏览器会把它渲染成字面 `[38;5;244m` 乱码（issue #16）。 */
const ANSI_RE = /\[[0-9:;<=>?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Strip all ANSI escape sequences (CSI/OSC) from a string. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Mock theme: TUI color functions degrade to identity so widget text survives. */
export const mockThemeProxy = new Proxy(
	{
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
		dim: (text: string) => text,
	},
	{
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			// Unknown theme methods → no-op passthrough.
			return (_arg: unknown, text?: unknown) => (text !== undefined ? text : "");
		},
	},
) as unknown as Theme;

/** Mock TUI: any method call is a safe no-op. */
const mockTui = new Proxy(
	{
		requestRender: () => {},
		render: () => {},
	},
	{
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			return () => {};
		},
	},
);

interface WidgetEntry {
	/** Renders the widget to plain text lines, or undefined when empty. */
	render: (width: number) => string[] | undefined;
	/** Whether the widget can be disposed. */
	dispose?: () => void;
}

/** A footer status entry, mirroring the server `statuses` message payload. */
export interface StatusEntry {
	key: string;
	text: string | undefined;
}

/**
 * Per-conversation footer status store. Extensions call `setStatus(key, text)`
 * through a per-conversation UI context; each write lands in the conversation
 * that made it. Only the ACTIVE conversation's entries are returned for
 * emission, so a background chat's role/status can never overwrite the active
 * footer. The active conversation is resolved lazily via `getActiveId` (the
 * server owns that pointer and can switch it without re-registering).
 */
export class ConversationStatuses {
	private byConv = new Map<string, Map<string, string>>();

	constructor(private readonly getActiveId: () => string) {}

	/** Record a status write for `convId`. Returns the snapshot to emit, or
	 *  null when the writer is not the active conversation (recorded for replay
	 *  when that conversation becomes active). */
	set(convId: string, key: string, text: string | undefined): StatusEntry[] | null {
		let map = this.byConv.get(convId);
		if (!map) {
			map = new Map();
			this.byConv.set(convId, map);
		}
		if (text === undefined || text === "") {
			map.delete(key);
		} else {
			map.set(key, text);
		}
		if (convId !== this.getActiveId()) return null;
		return this.snapshot(convId);
	}

	/** Snapshot of one conversation's entries (for switch/reconnect replay). */
	snapshot(convId: string): StatusEntry[] {
		const map = this.byConv.get(convId);
		if (!map) return [];
		return [...map.entries()].map(([key, text]) => ({ key, text }));
	}

	/** Snapshot of the ACTIVE conversation's entries. */
	activeSnapshot(): StatusEntry[] {
		return this.snapshot(this.getActiveId());
	}

	/** Drop a conversation's statuses when it is disposed. */
	remove(convId: string): void {
		this.byConv.delete(convId);
	}
}

/**
 * Implements the subset of ExtensionUIContext that makes sense for a web UI.
 * TUI-only affordances (select/confirm/input dialogs, terminal input, custom
 * footer) are inert: dialogs resolve to cancellation instead of blocking.
 */
export class WebUIContext {
	readonly theme = mockThemeProxy;
	private widgets = new Map<string, WidgetEntry>();
	private lastLines = new Map<string, string[]>();
	private emit: (msg: ServerMessage) => void;
	private readonly onBlockingDialog?: (conversationId: string) => void;

	constructor(emit: (msg: ServerMessage) => void, onBlockingDialog?: (conversationId: string) => void) {
		this.emit = emit;
		this.onBlockingDialog = onBlockingDialog;
	}

	// -- widgets -------------------------------------------------------------

	/** Register a widget whose lines come from a plain getter, re-evaluated on
	 *  every render/refresh (no SDK Component required). Used for
	 *  conversation-scoped overlays (e.g. markers) so switching conversations
	 *  re-renders them without re-registering. */
	setDynamicWidget(key: string, lines: () => string[]): void {
		this.widgets.set(key, { render: () => lines() });
		this.lastLines.delete(key);
		this.push();
	}

	/** Matches ExtensionUIContext's overloaded setWidget exactly. */
	setWidget: ExtensionUIContext["setWidget"] = (key, content, options) => {
		void options;
		// pi-todo's text overlay is superseded by the structured todo bridge
		// (server/todo-state.ts) — never surface it as a raw-lines widget.
		if (key === TODO_WIDGET_KEY) return;
		if (content === undefined) {
			this.widgets.delete(key);
			this.lastLines.delete(key);
			this.push();
			return;
		}
		if (typeof content === "function") {
			let comp: { render?: (w: number) => string[] | undefined; dispose?: () => void } | undefined;
			try {
				// Mock TUI/theme: extensions only read a handful of theme helpers;
				// everything else is a no-op, so the widget renders to plain text.
				comp = content(mockTui as never, mockThemeProxy as never) as typeof comp;
			} catch {
				comp = undefined;
			}
			this.widgets.set(key, {
				render: (w) => comp?.render?.(w),
				dispose: comp?.dispose,
			});
		} else {
			this.widgets.set(key, { render: () => content });
		}
		this.push();
	};

	/** Re-render all widgets and push when content changed (polled + on demand). */
	refresh(): void {
		let changed = false;
		for (const [key, w] of this.widgets) {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const prev = this.lastLines.get(key);
			if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
				this.lastLines.set(key, lines ?? []);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	private push(): void {
		const widgets = this.snapshot();
		this.emit({ type: "widgets", widgets });
	}

	/** Render all widgets to their current text lines (without emitting). */
	snapshot(): { key: string; lines: string[] }[] {
		return [...this.widgets.entries()].map(([key, w]) => {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			// 浏览器不是终端：ANSI 颜色码剥掉再下发/比对（issue #16）。
			const clean = lines?.map(stripAnsi) ?? undefined;
			this.lastLines.set(key, clean ?? []);
			return { key, lines: clean ?? [] };
		});
	}

	// -- notifications --------------------------------------------------------

	notify = (message: string, type?: "info" | "warning" | "error"): void => {
		this.emit({ type: "notice", level: type ?? "info", text: message });
	};

	// -- footer status (pi-lens "LSP Inactive", pi-cache-optimizer cache stats) --

	private statuses = new Map<string, string>();

	setStatus = (key: string, text: string | undefined): void => {
		if (text === undefined || text === "") {
			this.statuses.delete(key);
		} else {
			// 入口处剥 ANSI：pushStatuses / statusSnapshot 两条路径都拿到干净文本。
			const clean = stripAnsi(text);
			if (clean === "") this.statuses.delete(key);
			else this.statuses.set(key, clean);
		}
		this.pushStatuses();
	};

	private pushStatuses(): void {
		this.emit({
			type: "statuses",
			statuses: [...this.statuses.entries()].map(([k, v]) => ({
				key: k,
				text: v,
			})),
		});
	}

	/** Current footer status entries (for replay on socket attach). */
	statusSnapshot(): { key: string; text: string | undefined }[] {
		return [...this.statuses.entries()].map(([k, v]) => ({ key: k, text: v }));
	}

	// -- dialogs (select/confirm/input bridged to the browser) ---------------

	private dialogSeq = 0;
	private pendingDialogs = new Map<number, (value: string | boolean | null) => void>();

	select = (title: string, options: string[]): Promise<string | undefined> =>
		this.openDialog("select", title, [options]) as Promise<string | undefined>;
	confirm = (title: string, message: string): Promise<boolean> =>
		this.openDialog("confirm", title, [message]) as Promise<boolean>;
	input = (title: string, placeholder?: string): Promise<string | undefined> =>
		this.openDialog("input", title, [placeholder ?? ""]) as Promise<string | undefined>;

	private openDialog(
		kind: "select" | "confirm" | "input",
		title: string,
		args: unknown[],
		conversationId?: string,
	): Promise<string | boolean | null> {
		return new Promise((resolve) => {
			if (conversationId) this.onBlockingDialog?.(conversationId);
			const id = ++this.dialogSeq;
			this.pendingDialogs.set(id, resolve);
			this.emit({ type: "dialog", id, kind, title, args });
		});
	}

	/** Open a blocking extension dialog while retaining its owning conversation. */
	openDialogForOwner(
		conversationId: string,
		kind: "select" | "confirm" | "input",
		title: string,
		args: unknown[],
	): Promise<string | boolean | null> {
		return this.openDialog(kind, title, args, conversationId);
	}

	/** Resolve a pending dialog with the user's choice (called from the client). */
	resolveDialog(id: number, value: string | boolean | null): void {
		const resolve = this.pendingDialogs.get(id);
		if (resolve) {
			this.pendingDialogs.delete(id);
			resolve(value);
			this.emit({ type: "dialog_closed", id });
		}
	}

	/** Close every pending dialog as cancelled (used when a goal wizard aborts —
	 *  its unanswered browser dialogs must vanish, not linger). */
	cancelPendingDialogs(): void {
		for (const [id, resolve] of this.pendingDialogs) {
			this.pendingDialogs.delete(id);
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
	}

	// -- inert TUI-only affordances ------------------------------------------

	onTerminalInput = (): (() => void) => () => {};
	setWorkingMessage = (): void => {};
	setWorkingVisible = (): void => {};
	setWorkingIndicator = (): void => {};
	setHiddenThinkingLabel = (): void => {};
	setFooter = (): void => {};
	setHeader = (): void => {};
	setTitle = (): void => {};
	custom = <T>(_factory: unknown, _done?: unknown): Promise<T> => new Promise<T>(() => {});
	pasteToEditor = (): void => {};
	setEditorText = (): void => {};
	getEditorText = (): string => "";
	editor = async (): Promise<string | undefined> => undefined;
	addAutocompleteProvider = (): void => {};
	setEditorComponent = (): void => {};
	getEditorComponent = (): undefined => undefined;
	getAllThemes = (): { name: string; path: string | undefined }[] => [];
	getTheme = (): undefined => undefined;
	setTheme = (): { success: boolean; error?: string } => ({ success: false });
	getToolsExpanded = (): boolean => false;
	setToolsExpanded = (): void => {};

	/** Dispose all widgets (extension reload / session teardown). */
	dispose(): void {
		for (const w of this.widgets.values()) {
			try {
				w.dispose?.();
			} catch {
				// best effort
			}
		}
		this.widgets.clear();
		this.lastLines.clear();
		// Cancel any pending dialogs.
		for (const [id, resolve] of this.pendingDialogs) {
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
		this.pendingDialogs.clear();
	}
}
