/**
 * Syntax highlighting for the file preview: run highlight.js once over the
 * whole file, then split the HTML into one string per line while keeping the
 * span tree balanced — highlight.js happily opens a `<span>` on one line (a
 * block comment, a template literal) and closes it several lines later, and
 * the preview renders every line as its own row.
 *
 * `splitHighlightedLines` is pure and dependency-free so the balancing rule is
 * unit-testable; `highlightFile` is the small wrapper that picks a grammar
 * from the file name.
 */
import hljs from "highlight.js/lib/common";

/** File extension → highlight.js grammar (only names the common bundle ships). */
const EXT_LANG: Record<string, string> = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	json: "json",
	jsonc: "json",
	jsonl: "json",
	css: "css",
	scss: "scss",
	less: "less",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	vue: "xml",
	md: "markdown",
	markdown: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	cfg: "ini",
	conf: "ini",
	env: "bash",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	psm1: "powershell",
	py: "python",
	pyi: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	diff: "diff",
	patch: "diff",
	dockerfile: "dockerfile",
	makefile: "makefile",
	lua: "lua",
	r: "r",
	pl: "perl",
	scala: "scala",
	objc: "objectivec",
	m: "objectivec",
	wasm: "wasm",
	txt: "plaintext",
	log: "plaintext",
};

/** Files named without an extension that still have a grammar. */
const NAME_LANG: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	".bashrc": "bash",
	".zshrc": "bash",
	".profile": "bash",
	".gitignore": "plaintext",
	".env": "bash",
};

/** Above this many bytes the file is shown plain — highlighting is O(n) but
 *  the per-line HTML doubles the DOM cost of a 5000-line preview. */
export const HIGHLIGHT_MAX_BYTES = 400 * 1024;

export function languageFor(fileName: string): string | undefined {
	const base = fileName.split(/[\\/]/).pop() ?? fileName;
	const lower = base.toLowerCase();
	if (NAME_LANG[lower]) return NAME_LANG[lower];
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return undefined;
	return EXT_LANG[lower.slice(dot + 1)];
}

const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Split highlight.js output into per-line HTML. Every line is self-contained:
 * spans left open at a line break are closed there and reopened on the next
 * line with the same class, so each row renders identically to the joined
 * whole. Text is already escaped by highlight.js; only tags are parsed.
 */
export function splitHighlightedLines(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = []; // open tags, in order
	let cur = "";
	let i = 0;
	const n = html.length;
	while (i < n) {
		const ch = html[i];
		if (ch === "<") {
			const end = html.indexOf(">", i);
			if (end < 0) {
				cur += html.slice(i);
				break;
			}
			const tag = html.slice(i, end + 1);
			if (tag.startsWith("</")) {
				open.pop();
			} else if (!tag.endsWith("/>")) {
				open.push(tag);
			}
			cur += tag;
			i = end + 1;
			continue;
		}
		if (ch === "\n") {
			for (let k = open.length; k > 0; k--) cur += "</span>";
			lines.push(cur);
			cur = open.join("");
			i++;
			continue;
		}
		// copy a run of plain characters at once
		let j = i + 1;
		while (j < n && html[j] !== "<" && html[j] !== "\n") j++;
		cur += html.slice(i, j);
		i = j;
	}
	for (let k = open.length; k > 0; k--) cur += "</span>";
	lines.push(cur);
	return lines;
}

export interface HighlightedFile {
	/** One HTML string per source line (escaped, balanced spans). */
	lines: string[];
	/** Grammar used, or undefined when the file was left plain. */
	language?: string;
}

/**
 * Highlight `text` for display as separate line rows. Unknown extensions,
 * oversized files and grammar errors fall back to escaped plain lines so the
 * preview never loses content over a highlighting hiccup.
 */
export function highlightFile(text: string, fileName: string): HighlightedFile {
	const plain = (): HighlightedFile => ({ lines: text.split("\n").map(escapeHtml) });
	const language = languageFor(fileName);
	if (!language || language === "plaintext") return plain();
	if (text.length > HIGHLIGHT_MAX_BYTES) return plain();
	if (!hljs.getLanguage(language)) return plain();
	try {
		const { value } = hljs.highlight(text, { language, ignoreIllegals: true });
		return { lines: splitHighlightedLines(value), language };
	} catch {
		return plain();
	}
}
