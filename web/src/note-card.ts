/**
 * note_write tool call → note card data. Pure (unit-tested).
 *
 * The finished tool result carries the authoritative note in `details`
 * (server/tutor.ts NoteWriteDetails). Before that lands — while the model is
 * still streaming the call — fall back to the call's own arguments, which
 * only parse once the JSON is complete.
 */

/** Tool name the server registers for concept notes (server/tutor.ts). */
export const NOTE_WRITE_TOOL = "note_write";

export interface NoteCardData {
	title: string;
	content: string;
	/** Path relative to the topic folder, e.g. notes/closures.md (result only). */
	path?: string;
	/** True = first write, false = replaced an existing note, undefined = unknown yet. */
	created?: boolean;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v : undefined;
}

export function noteCardData(argumentsText: string | undefined, resultDetails: unknown): NoteCardData | null {
	if (resultDetails && typeof resultDetails === "object") {
		const d = resultDetails as Record<string, unknown>;
		const title = str(d.title);
		const content = str(d.content);
		if (d.kind === "note" && title && content) {
			return {
				title,
				content,
				path: str(d.path),
				created: typeof d.created === "boolean" ? d.created : undefined,
			};
		}
	}
	if (!argumentsText) return null;
	try {
		const a = JSON.parse(argumentsText) as Record<string, unknown>;
		const title = str(a.title);
		const content = str(a.content);
		return title && content ? { title, content } : null;
	} catch {
		return null;
	}
}
