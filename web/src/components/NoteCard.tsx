import { memo, useState } from "react";
import { FiBookOpen, FiChevronDown, FiChevronRight } from "react-icons/fi";
import type { NoteCardData } from "../note-card";
import { Markdown } from "./Markdown";

/**
 * A concept note written by the tutor (note_write), shown as the note itself
 * rather than as a tool call: the tutor does not repeat the note in chat, so
 * this card is the explanation. Open by default; the header folds it away.
 * `note` is null while the call is still streaming.
 */
export const NoteCard = memo(function NoteCard({
	note,
	pending,
	forceOpen = false,
}: {
	note: NoteCardData | null;
	/** Call still streaming / executing. */
	pending: boolean;
	forceOpen?: boolean;
}) {
	const [open, setOpen] = useState(true);
	const shown = open || forceOpen;
	const badge = note?.created === true ? "new" : note?.created === false ? "updated" : undefined;

	return (
		<section className={`note-card${shown ? "" : " collapsed"}`} aria-label={note ? `Note: ${note.title}` : "Note"}>
			<button
				type="button"
				className="note-card-head"
				aria-expanded={shown}
				onClick={() => setOpen(!open)}
				title={shown ? "Fold note" : "Show note"}
			>
				{shown ? <FiChevronDown /> : <FiChevronRight />}
				<FiBookOpen className="note-card-icon" />
				<span className={`note-card-title${pending && !note ? " shimmer" : ""}`}>
					{note ? note.title : "Writing note…"}
				</span>
				{badge && <span className="note-card-badge">{badge}</span>}
				<span className="note-card-spacer" />
				{note?.path && <span className="note-card-path">{note.path}</span>}
			</button>
			{shown && note && (
				<div className="note-card-body">
					<Markdown text={note.content} />
				</div>
			)}
		</section>
	);
});
