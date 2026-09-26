import type { CSSProperties } from "react";
import type { LearnEvent } from "../types";

const cardStyle: CSSProperties = {
	display: "flex",
	alignItems: "baseline",
	gap: 10,
	margin: "10px var(--chat-inset, 20px) 0",
	padding: "8px 14px",
	border: "1px solid var(--border-soft)",
	borderRadius: "var(--radius-md, 10px)",
	background: "var(--bg-elev2)",
	color: "var(--text-dim)",
	fontSize: 13.5,
	lineHeight: 1.45,
};

const badgeStyle: CSSProperties = {
	flex: "none",
	padding: "1px 7px",
	border: "1px solid var(--border-soft)",
	borderRadius: 999,
	background: "var(--bg-elev2)",
	color: "var(--text-faint)",
	fontSize: 11.5,
	fontWeight: 600,
	letterSpacing: "0.02em",
	whiteSpace: "nowrap",
};

/**
 * Unobtrusive inline card for a server `learn_event` (Phase-0 `demo` beat).
 * Transient: use-chat drops it when the conversation changes, so it never
 * renders over an unrelated transcript.
 */
export function LearningEventCard({ event }: { event: LearnEvent }) {
	return (
		<section className="learn-event-card" aria-label="Learning event" style={cardStyle}>
			<span style={badgeStyle}>
				v{event.version} · {event.type}
			</span>
			<p style={{ margin: 0 }}>{event.message}</p>
		</section>
	);
}
