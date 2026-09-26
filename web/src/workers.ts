/**
 * Pure helpers for delegated workers (PiAstra `delegate` tool): grouping for
 * the Workers pane (Running / Finished / Failed), per-card lookup for the
 * delegate tool card, elapsed-time and status labels. No DOM, no React —
 * unit-tested in tests/unit/workers-view.test.ts.
 */
import type { UiMessage, UiWorker, UiWorkerStatus } from "./types";

/** Statuses of a worker that is still attached and may change. */
export function isWorkerActive(status: UiWorkerStatus): boolean {
	return status === "starting" || status === "running";
}

/** Running in start order; finished and failed workers independently newest first. */
export function splitWorkers(workers: readonly UiWorker[]): {
	active: UiWorker[];
	done: UiWorker[];
	failed: UiWorker[];
} {
	const active = workers.filter((w) => isWorkerActive(w.status)).sort((a, b) => a.id - b.id);
	const done = workers.filter((w) => !isWorkerActive(w.status) && w.status !== "failed").sort((a, b) => b.id - a.id);
	const failed = workers.filter((w) => w.status === "failed").sort((a, b) => b.id - a.id);
	return { active, done, failed };
}

/**
 * Workers belonging to one delegate tool call. Live/restored workers carry the
 * call id; a saved session from before that field existed falls back to the
 * workers array persisted in the tool result's details.
 */
export function workersForCall(
	workers: readonly UiWorker[],
	toolCallId: string,
	result: UiMessage | undefined,
): UiWorker[] {
	const linked = workers.filter((w) => w.toolCallId === toolCallId).sort((a, b) => a.id - b.id);
	if (linked.length > 0) return linked;
	return workersFromDetails(result?.details);
}

/** Coerce `details.workers` of a saved delegate result into UiWorker rows. */
export function workersFromDetails(details: unknown): UiWorker[] {
	const list = (details as { workers?: unknown } | null | undefined)?.workers;
	if (!Array.isArray(list)) return [];
	const out: UiWorker[] = [];
	for (const raw of list) {
		const w = raw as Record<string, unknown> | null;
		if (!w || typeof w.id !== "number") continue;
		const status = w.status;
		out.push({
			id: w.id,
			toolCallId: typeof w.toolCallId === "string" ? w.toolCallId : undefined,
			role: String(w.role ?? ""),
			model: String(w.model ?? ""),
			task: String(w.task ?? ""),
			// a saved worker that never finished is no longer attached
			status:
				status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
					? status
					: "interrupted",
			activity: String(w.activity ?? ""),
			started: typeof w.started === "number" ? w.started : 0,
			ended: typeof w.ended === "number" ? w.ended : undefined,
			recent: Array.isArray(w.recent) ? w.recent.filter((x): x is string => typeof x === "string") : [],
			text: typeof w.text === "string" ? w.text : "",
			hasTranscript: false,
		});
	}
	return out.sort((a, b) => a.id - b.id);
}

/** Seconds a worker has run: live ones count up to `now`, finished ones
 *  freeze at `ended`. null when unknowable (a restored worker that never
 *  finished has no end time — counting to now would show hours of nothing). */
export function workerElapsedSec(w: Pick<UiWorker, "started" | "ended" | "status">, now = Date.now()): number | null {
	if (!w.started) return null;
	const end = w.ended ?? (isWorkerActive(w.status) ? now : null);
	if (end === null) return null;
	return Math.max(0, Math.floor((end - w.started) / 1000));
}

/** "42s" / "3m 05s" / "1h 02m"; "" when unknown. */
export function formatElapsed(sec: number | null): string {
	if (sec === null) return "";
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Human label per status (the extension's activity line carries the detail). */
export function workerStatusLabel(status: UiWorkerStatus): string {
	switch (status) {
		case "starting":
			return "Starting";
		case "running":
			return "Running";
		case "completed":
			return "Done";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
		case "interrupted":
			return "Interrupted";
	}
}

/** Tone class for status chips: run / ok / err / idle. */
export function workerStatusTone(status: UiWorkerStatus): "run" | "ok" | "err" | "idle" {
	if (isWorkerActive(status)) return "run";
	if (status === "completed") return "ok";
	if (status === "interrupted") return "idle";
	return "err";
}

/** One-line task preview for list rows (first line, whitespace collapsed). */
export function taskPreview(task: string, max = 160): string {
	const line = task.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
