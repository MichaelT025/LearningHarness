import { useState } from "react";
import { FiArrowUpRight, FiChevronDown, FiChevronRight } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT, type Translate } from "../i18n";
import { Markdown } from "./Markdown";
import { RoleChip } from "./RoleChip";
import { OPEN_WORKER_EVENT } from "./ToolCallBlock";

/** Message type the Dispatch extension uses to push finished workers back into
 *  the parent conversation (extensions/piastra/worker-runtime.mjs). */
export const WORKER_RESULT_TYPE = "dispatch-worker-result";

/** One entry of `details.results` on a worker-result message. Loosely typed:
 *  it comes from an extension event, not from this codebase. */
interface WorkerResultDetail {
	id: number;
	role?: string;
	status?: string;
	ok?: boolean;
	text?: string;
	elapsed?: string;
}

/** Results carried by a `dispatch-worker-result` message, in the order the
 *  extension listed them. Empty when the details are missing or malformed
 *  (the caller then falls back to the plain text renderer). */
export function workerResultsFromDetails(details: unknown): WorkerResultDetail[] {
	const list = (details as { results?: unknown } | null | undefined)?.results;
	if (!Array.isArray(list)) return [];
	const out: WorkerResultDetail[] = [];
	for (const raw of list) {
		const r = raw as Record<string, unknown> | null;
		if (!r || typeof r.id !== "number") continue;
		out.push({
			id: r.id,
			role: typeof r.role === "string" ? r.role : undefined,
			status: typeof r.status === "string" ? r.status : undefined,
			ok: typeof r.ok === "boolean" ? r.ok : undefined,
			text: typeof r.text === "string" ? r.text : "",
			elapsed: typeof r.elapsed === "string" ? r.elapsed : undefined,
		});
	}
	return out;
}

/** Verb for the collapsed line: finished / failed / cancelled / interrupted. */
function resultVerb(r: WorkerResultDetail): {
	key: "workerFinished" | "workerFailed" | "workerCancelled" | "workerInterrupted";
	tone: "ok" | "err" | "idle";
} {
	const status = r.status ?? (r.ok === false ? "failed" : "completed");
	if (status === "completed") return { key: "workerFinished", tone: "ok" };
	if (status === "cancelled") return { key: "workerCancelled", tone: "err" };
	if (status === "interrupted") return { key: "workerInterrupted", tone: "idle" };
	return { key: "workerFailed", tone: "err" };
}

/** Collapsed-message preview: "review #13 finished, fast #12 failed". */
export function workerResultPreview(results: readonly WorkerResultDetail[], t: Translate): string {
	return results.map((r) => `${r.role ?? "worker"} #${r.id} ${t(resultVerb(r).key)}`).join(", ");
}

/**
 * Chat card for a `dispatch-worker-result` message: one collapsed line per
 * worker ("review #13 finished · 37s"); expanding a line shows that worker's
 * result as Markdown. The message's text body is what the MODEL reads — the
 * same information, plus transcript paths — so it is not repeated here.
 */
export function WorkerResultCard({ message, forceOpen = false }: { message: UiMessage; forceOpen?: boolean }) {
	const results = workerResultsFromDetails(message.details);
	return (
		<div className="workerresults">
			{results.map((r) => (
				<WorkerResultRow key={r.id} result={r} forceOpen={forceOpen} />
			))}
		</div>
	);
}

function WorkerResultRow({ result, forceOpen }: { result: WorkerResultDetail; forceOpen: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	// During search the body must be in the DOM for highlighting, as with the
	// attachment and skill cards.
	const shown = open || forceOpen;
	const { key, tone } = resultVerb(result);
	const hasText = (result.text ?? "").trim().length > 0;
	const toggle = () => setOpen((v) => (forceOpen ? true : !v));
	const openTranscript = () =>
		window.dispatchEvent(new CustomEvent<number | null>(OPEN_WORKER_EVENT, { detail: result.id }));
	return (
		<div className={`workerresult tone-${tone}`} data-role={result.role}>
			<div
				className="chead workerresult-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={shown ? t("collapseMsg") : t("expandMsg")}
				onClick={toggle}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						toggle();
					}
				}}
			>
				<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
				<RoleChip role={result.role ?? ""} />
				<span className="worker-id">#{result.id}</span>
				<span className="workerresult-verb">{t(key)}</span>
				{result.elapsed && <span className="worker-elapsed">{result.elapsed}</span>}
				<span className="worker-spacer" />
				<button
					type="button"
					className="chead-copy workerresult-open"
					title={t("workersOpenOne")}
					aria-label={t("workersOpenOne")}
					onClick={(e) => {
						e.stopPropagation();
						openTranscript();
					}}
				>
					<FiArrowUpRight />
				</button>
			</div>
			{shown && (
				<div className="workerresult-body">
					{hasText ? (
						<Markdown text={result.text ?? ""} />
					) : (
						<span className="workerresult-empty">{t("workerNoResult")}</span>
					)}
				</div>
			)}
		</div>
	);
}
