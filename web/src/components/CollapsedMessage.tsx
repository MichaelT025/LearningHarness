import { memo } from "react";
import { FiChevronRight, FiCpu, FiImage, FiTerminal } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import { asBash, asImage, asText, asThinking, asToolCall, roleLabel } from "./Message";
import { ToolIcon } from "./ToolCallBlock";
import { commandPreview, toolSummary } from "../tool-summary";
import { toolArgHints } from "../tool-args";
import { thinkingPreviewLine } from "../thinking-preview";

import { parseSkillBlock } from "../skill-block";
import { WORKER_RESULT_TYPE, workerResultPreview, workerResultsFromDetails } from "./WorkerResultCard";

interface CollapsedMessageProps {
	message: UiMessage;
	onExpand: (messageId: string) => void;
}

const PREVIEW_MAX = 90;
const MAX_LINES = 6;

/** One cheap line per content block — what the full card's HEADER would say,
 *  without the card: "Read src/app.ts", "Thinking: first line…", the first
 *  line of prose. */
type Line = {
	kind: "text" | "thinking" | "tool" | "bash" | "image";
	icon?: string;
	verb?: string;
	target?: string;
	mono?: boolean;
	text?: string;
};

function clip(s: string, max = PREVIEW_MAX): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Cheap summary row for messages outside the recent window. Renders NO heavy
 * content (no Markdown, no thinking body, no tool output, no attachments) —
 * one short line per block: the tool card's summary line, the thinking
 * header's first line, the first line of prose. The full message is only
 * rendered after the user clicks to expand.
 */
export const CollapsedMessage = memo(function CollapsedMessage({ message, onExpand }: CollapsedMessageProps) {
	const t = useT();

	// Worker results: "review #13 finished, fast #12 failed" instead of the
	// model-facing text dump.
	const workerResults =
		message.role === "custom" && message.customType === WORKER_RESULT_TYPE
			? workerResultsFromDetails(message.details)
			: [];

	const lines: Line[] = [];
	if (workerResults.length > 0) {
		lines.push({ kind: "text", text: workerResultPreview(workerResults, t) });
	} else if (message.role === "custom" && message.customType === "file") {
		// Attached files get their name as the preview.
		const details = (message.details ?? {}) as { name?: string; path?: string };
		lines.push({ kind: "text", text: details.name ?? details.path ?? "" });
	} else {
		let images = 0;
		for (const b of message.content) {
			const text = asText(b);
			if (text) {
				if (!text.text.trim()) continue;
				// Skill invocations collapse to a `skill:name · <args>` chip instead
				// of the raw SKILL.md dump.
				const sb = parseSkillBlock(text.text);
				lines.push({
					kind: "text",
					text: sb ? `skill:${sb.name}` + (sb.userMessage ? ` · ${clip(sb.userMessage)}` : "") : clip(text.text),
				});
				continue;
			}
			const th = asThinking(b);
			if (th) {
				lines.push({ kind: "thinking", text: t("thinkingPreview", { preview: thinkingPreviewLine(th.thinking) }) });
				continue;
			}
			const tc = asToolCall(b);
			if (tc) {
				const s = toolSummary(tc.name, toolArgHints(tc.argumentsText), "done");
				lines.push({ kind: "tool", icon: tc.name, verb: s.verb, target: s.target, mono: s.mono });
				continue;
			}
			const bash = asBash(b);
			if (bash) {
				lines.push({ kind: "bash", verb: t("bashRan"), target: commandPreview(bash.command), mono: true });
				continue;
			}
			if (asImage(b)) images++;
		}
		if (images) lines.push({ kind: "image", text: `${t("images")} ${images}` });
	}
	const overflow = lines.length - MAX_LINES;
	const shownLines = overflow > 0 ? lines.slice(0, MAX_LINES) : lines;
	const titleText = lines
		.map((l) => l.text ?? `${l.verb ?? ""} ${l.target ?? ""}`.trim())
		.filter(Boolean)
		.join(" · ");

	return (
		<div
			role="button"
			tabIndex={0}
			className="msg-collapsed"
			data-msg-id={message.id}
			title={`${t("expandMsg")} · ${titleText || message.role}`}
			onClick={() => onExpand(message.id)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onExpand(message.id);
				}
			}}
		>
			<span className={`msg-collapsed-role role-${message.role}`}>
				{message.role === "custom" && message.customType === "file"
					? t("attachment")
					: workerResults.length > 0
						? t("workerResultsLabel")
						: roleLabel(message.role, t)}
			</span>
			<span className="msg-collapsed-body">
				{shownLines.map((l, i) =>
					l.kind === "text" ? (
						<span key={i} className="msg-collapsed-preview">
							{l.text}
						</span>
					) : l.kind === "thinking" ? (
						<span key={i} className="msg-collapsed-line thinking">
							<FiCpu aria-hidden="true" />
							<span className="msg-collapsed-line-text">{l.text}</span>
						</span>
					) : l.kind === "image" ? (
						<span key={i} className="msg-collapsed-line">
							<FiImage aria-hidden="true" />
							<span className="msg-collapsed-line-text">{l.text}</span>
						</span>
					) : (
						<span key={i} className="msg-collapsed-line tool">
							{l.kind === "bash" ? <FiTerminal aria-hidden="true" /> : <ToolIcon name={l.icon ?? ""} />}
							<span className="msg-collapsed-line-text">
								<span className="msg-collapsed-verb">{l.verb}</span>
								{l.target && <span className={`msg-collapsed-target${l.mono ? " mono" : ""}`}>{l.target}</span>}
							</span>
						</span>
					),
				)}
				{overflow > 0 && <span className="msg-collapsed-more">{t("collapsedMore", { n: overflow })}</span>}
			</span>
			{message.timestamp ? <span className="msg-collapsed-time">{formatTime(message.timestamp)}</span> : null}
			<span className="msg-collapsed-action">
				<FiChevronRight /> {t("expandMsg")}
			</span>
		</div>
	);
});

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
