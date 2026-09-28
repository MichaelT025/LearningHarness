import { memo, useEffect, useState, type ReactNode } from "react";

/**
 * ```mermaid``` fences render as diagrams (the tutor draws its roadmap and
 * dependency maps this way). mermaid is large, so it is loaded on first use
 * only. While loading, or when the source doesn't parse, the fence shows as
 * the plain code block it would otherwise be (`fallback`).
 */

type MermaidApi = typeof import("mermaid").default;

let loader: Promise<MermaidApi> | null = null;
let seq = 0;

/** Dark UI → mermaid's dark theme (judged from the page background). */
function isDarkUi(): boolean {
	const bg = getComputedStyle(document.body).backgroundColor;
	const m = bg.match(/\d+(\.\d+)?/g);
	if (!m || m.length < 3) return true;
	const [r, g, b] = m.map(Number);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function loadMermaid(): Promise<MermaidApi> {
	loader ??= import("mermaid").then((mod) => {
		const mermaid = mod.default;
		mermaid.initialize({
			startOnLoad: false,
			// Model-written source: no clicks/scripts/HTML labels.
			securityLevel: "strict",
			theme: isDarkUi() ? "dark" : "default",
			fontFamily: "inherit",
		});
		return mermaid;
	});
	return loader;
}

export const MermaidBlock = memo(function MermaidBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
	const [svg, setSvg] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setSvg(null);
		void loadMermaid()
			.then(async (mermaid) => {
				// parse first: render() on bad input leaves an error SVG in the DOM.
				if (!(await mermaid.parse(source, { suppressErrors: true }))) return;
				const { svg: out } = await mermaid.render(`lh-mermaid-${++seq}`, source);
				if (!cancelled) setSvg(out);
			})
			.catch(() => {
				// Stay on the code fallback.
			});
		return () => {
			cancelled = true;
		};
	}, [source]);

	if (!svg) return <>{fallback}</>;
	return <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />;
});
