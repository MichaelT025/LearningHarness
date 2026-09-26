/// <reference lib="dom" />
/** CSS variable → xterm theme. Reads the --term-* palette from the applied
 *  stylesheet so the terminal canvas follows the app palette. */
export function buildTermTheme(): Record<string, string> {
	const cs = getComputedStyle(document.documentElement);
	const v = (name: string, fallback: string) => {
		const val = cs.getPropertyValue(name).trim();
		return val || fallback;
	};
	return {
		background: v("--term-bg", "#0b0d12"),
		foreground: v("--term-fg", "#e6e8ef"),
		cursor: v("--term-cursor", "#8b5cf6"),
		cursorAccent: v("--term-cursor-accent", "#0b0d12"),
		selectionBackground: v("--term-selection", "rgba(139, 92, 246, 0.35)"),
		black: v("--term-black", "#1a1d26"),
		red: v("--term-red", "#f87171"),
		green: v("--term-green", "#34d399"),
		yellow: v("--term-yellow", "#fbbf24"),
		blue: v("--term-blue", "#60a5fa"),
		magenta: v("--term-magenta", "#c084fc"),
		cyan: v("--term-cyan", "#22d3ee"),
		white: v("--term-white", "#e6e8ef"),
		brightBlack: v("--term-bright-black", "#6b7284"),
		brightRed: v("--term-bright-red", "#f87171"),
		brightGreen: v("--term-bright-green", "#34d399"),
		brightYellow: v("--term-bright-yellow", "#fbbf24"),
		brightBlue: v("--term-bright-blue", "#60a5fa"),
		brightMagenta: v("--term-bright-magenta", "#c084fc"),
		brightCyan: v("--term-bright-cyan", "#22d3ee"),
		brightWhite: v("--term-bright-white", "#ffffff"),
	};
}
