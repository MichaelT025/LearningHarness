/**
 * One-line preview of a thinking block for collapsed headers. Models tend
 * to open with a bold heading ("**Checking provider auth lookup**") and a
 * Markdown title now and then; those are skipped so the preview is the first
 * line of actual reasoning. When the block is only a heading, its text is
 * used without the markers. Never renders Markdown — plain text only.
 */
const HEADING = /^\s*(?:#{1,6}\s+.*|\*\*[^*]+\*\*\s*:?|__[^_]+__\s*:?)\s*$/;

export function thinkingPreviewLine(thinking: string, max = 80): string {
	const lines = thinking.split(/\r?\n/).filter((l) => l.trim());
	const body = lines.find((l) => !HEADING.test(l));
	const raw = body ?? lines[0] ?? "";
	const text = (body ? raw : stripHeading(raw)).replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stripHeading(line: string): string {
	return line
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/^\s*\*\*([^*]+)\*\*\s*:?\s*$/, "$1")
		.replace(/^\s*__([^_]+)__\s*:?\s*$/, "$1");
}
