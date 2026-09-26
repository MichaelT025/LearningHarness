import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CommandDef } from "../types";
import { buildTermTheme } from "../theme";
import { useI18n } from "../i18n";
import { appSend } from "../app-globals";

/** Strip exit sentinels/baked banners; the banner itself renders on terminal_exit. */
export function stripExitBanner(data: string): { clean: string; exitCode: number | null } {
	let exitCode: number | null = null;
	const clean = data
		.replace(/\r?\n?\[pi-term-exit:(-?\d+)\]\r?\n?/g, (_, c: string) => {
			exitCode = Number(c);
			return "\r\n";
		})
		.replace(/\r?\n?\x1b\[90m\[(?:进程已退出，退出码 |Process exited with code )-?\d+\]\x1b\[0m\r?\n?/g, "\r\n");
	return { clean, exitCode };
}

interface TermXtermProps {
	conversationId: string;
	terminalId: string;
	/** When set, the server runs this command in a new shell instead of a bare shell. */
	command?: CommandDef;
	/** Directory for a bare shell (from the snapshot at tab creation). */
	cwd: string;
	/** Display title (sent to server so the PTY metadata uses the correct locale). */
	title?: string;
	/** Whether this terminal is the visible one. */
	active: boolean;
	/** Live running flag (banner renders when this flips false). */
	running?: boolean;
	/** Exit code (banner text). */
	exitCode?: number | null;
	register: (conversationId: string, id: string, writer: { write(data: string): void; dispose(): void }) => () => void;
}

/**
 * One xterm instance per terminal tab. Owns the PTY lifecycle: creates it on
 * mount (bare shell or run_command), forwards input/resize, streams output via
 * the bridge, and kills the PTY on unmount. Kept mounted while hidden so
 * scrollback survives tab switches.
 */
export function TermXterm({
	conversationId,
	terminalId,
	command,
	cwd,
	title,
	active,
	running,
	exitCode,
	register,
}: TermXtermProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
	// Metadata snapshots recreate the command object; use a value key so a
	// terminal is not torn down when only its running/exit metadata changes.
	const commandKey = command ? JSON.stringify(command) : "";

	// Mount/unmount: create the xterm, register with the output bridge, spawn
	// the server-side PTY, wire input + resize. Never re-runs on tab switches
	// (command identity is stable — the meta object is only ever spread).
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const term = new Terminal({
			theme: buildTermTheme(),
			fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
			fontSize: 13.5,
			cursorBlink: true,
			scrollback: 8000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = { term, fit };
		if (active) term.focus();

		// xterm maps Ctrl+V to ^V (0x16, readline quoted-insert) and Ctrl+C to
		// ^C, preventDefault()ing both, so the browser's native copy/paste never
		// fires. Returning false skips xterm's key handling entirely:
		//   · Ctrl+V / Cmd+V → browser-native paste (event lands on xterm's
		//     helper textarea and is forwarded to the shell)
		//   · Ctrl+C with a selection → copy instead of ^C (text staged in the
		//     helper textarea, same trick as xterm's own right-click copy; no
		//     clipboard-API permission needed, works over plain http)
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") return true;
			const key = event.key?.toLowerCase();
			if ((event.ctrlKey || event.metaKey) && key === "v") {
				return false;
			}
			if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "c") {
				if (term.hasSelection()) {
					const ta = term.textarea;
					if (ta) {
						ta.value = term.getSelection();
						ta.select();
					}
					return false;
				}
			}
			return true;
		});

		const unregister = register(conversationId, terminalId, {
			write: (data) => term.write(stripExitBanner(data).clean),
			dispose: () => term.dispose(),
		});

		const sendDims = () => {
			try {
				fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId,
					cols: term.cols,
					rows: term.rows,
				});
			} catch {
				// Container hidden — will re-fit when shown.
			}
		};

		// Spawn the PTY with the real fitted size (80x24 until layout settles).
		const raf = requestAnimationFrame(() => {
			try {
				fit.fit();
			} catch {
				// ignore
			}
			if (command) {
				appSend({
					type: "run_command",
					terminalId,
					conversationId,
					command,
					cols: term.cols,
					rows: term.rows,
				});
			} else {
				appSend({
					type: "terminal_create",
					terminalId,
					title,
					conversationId,
					cwd,
					cols: term.cols,
					rows: term.rows,
				});
			}
		});

		const onData = term.onData((data) => {
			appSend({ type: "terminal_input", terminalId, conversationId, data });
		});

		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(() => {
				if (container.offsetWidth > 0 && container.offsetHeight > 0) {
					sendDims();
				}
			});
			ro.observe(container);
		}

		return () => {
			cancelAnimationFrame(raf);
			onData.dispose();
			ro?.disconnect();
			unregister();
			// Unmounting happens when switching conversations/views; the PTY is
			// persistent and is killed only by an explicit close action or agent tool.
			term.dispose();
			termRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationId, terminalId, commandKey, register]);

	// Becoming visible: re-fit (size may have changed while hidden) and focus.
	useEffect(() => {
		if (!active) return;
		const raf = requestAnimationFrame(() => {
			const inst = termRef.current;
			if (!inst) return;
			try {
				inst.fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId,
					cols: inst.term.cols,
					rows: inst.term.rows,
				});
			} catch {
				// ignore
			}
			inst.term.focus();
		});
		return () => cancelAnimationFrame(raf);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// Exit banner in the LIVE locale (reads t() at effect time, not at
	// PTY-creation time). Guarded by the running-state edge: the banner is
	// written once per running→stopped transition, so reruns in the SAME tab
	// (TerminalPanel reuses the component instance) and remounts of already-
	// stopped terminals each render their banner without duplicates.
	const { t } = useI18n();
	const lastRunning = useRef<boolean | undefined>(undefined);
	useEffect(() => {
		if (running === lastRunning.current) return;
		lastRunning.current = running;
		if (running !== false) return;
		const inst = termRef.current;
		if (!inst) return;
		inst.term.write(`\r\n\x1b[90m${t("exitBanner", { code: exitCode ?? "" })}\x1b[0m\r\n`);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running, terminalId, exitCode]);

	return <div ref={containerRef} className={`term-xterm ${active ? "" : "hidden"}`} />;
}
