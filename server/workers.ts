/**
 * Delegated-worker state for ONE conversation (the PiAstra `delegate` tool).
 *
 * The PiAstra extension publishes workers on its `piastra:workers` extension
 * event channel (see PiAstra/extensions/piastra/worker-bridge.mjs): a full
 * worker list on every progress tick and `transcript` events carrying the
 * live worker session messages. This module keeps that state per
 * conversation, serializes transcripts into the ordinary UiMessage shape
 * (so the Workers pane renders them with the chat's own components) and
 * reads saved JSONL transcripts for workers that finished in an earlier
 * process. Everything network-facing (sinks, throttling, snapshots) stays in
 * agent-service.ts; this file is pure state + parsing so it can be unit-tested.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UiMessage, UiWorker, UiWorkerStatus, UiWorkerTranscript } from "./protocol.js";
import { serializeMessage, serializeStreamingMessage, type AgentMessage } from "./serialize.js";

/** Extension event channel (must match the PiAstra worker bridge). */
export const WORKER_CHANNEL = "piastra:workers";

const STATUSES: readonly UiWorkerStatus[] = ["starting", "running", "completed", "failed", "cancelled", "interrupted"];

/** Raw worker summary as the extension publishes it (untrusted shape). */
interface BridgeWorker {
	id: number;
	toolCallId?: string;
	role?: string;
	model?: string;
	task?: string;
	status?: string;
	activity?: string;
	started?: number;
	ended?: number;
	transcript?: string;
	recent?: unknown;
	text?: unknown;
}

/** Inbound bridge events (version 1). Anything else is ignored. */
export type BridgeEvent =
	| { version: 1; type: "workers"; workers: BridgeWorker[] }
	| { version: 1; type: "transcript"; workerId: number; messages: AgentMessage[]; streaming: AgentMessage | null };

interface WorkerRecord {
	summary: Omit<UiWorker, "hasTranscript">;
	/** Saved JSONL path (extension-reported); read when there is no live state. */
	transcriptFile?: string;
	/** Live session state from `transcript` events (reference to the SDK's
	 *  array — serialized lazily, only when a client follows the worker). */
	live?: { messages: AgentMessage[]; streaming: AgentMessage | null };
	/** Per-worker UiMessage cache: persisted messages are content-immutable,
	 *  so each is serialized once (keyed like the main conversation's cache). */
	ids: Map<string, number>;
	cache: Map<string, UiMessage>;
	/** Parsed saved transcript, cached once the worker can no longer change. */
	fileMessages?: UiMessage[];
}

export function isBridgeEvent(event: unknown): event is BridgeEvent {
	if (typeof event !== "object" || event === null) return false;
	const e = event as { version?: unknown; type?: unknown; workers?: unknown; workerId?: unknown };
	if (e.version !== 1) return false;
	if (e.type === "workers") return Array.isArray(e.workers);
	if (e.type === "transcript") return typeof e.workerId === "number";
	return false;
}

function asStatus(s: unknown): UiWorkerStatus {
	return STATUSES.includes(s as UiWorkerStatus) ? (s as UiWorkerStatus) : "starting";
}

function asStringList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Terminal statuses: the worker's transcript can no longer change. */
export function isFinished(status: UiWorkerStatus): boolean {
	return status !== "starting" && status !== "running";
}

/**
 * Whether a transcript path may be read: only files inside the extension's
 * run directory (`<agentDir>/piastra/runs`). The path comes from an extension
 * event, not from the browser, but the browser picks WHICH worker to open,
 * so keep the read surface bounded anyway.
 */
export function isAllowedTranscriptPath(file: string, agentDir: string): boolean {
	const runs = path.resolve(agentDir, "piastra", "runs");
	const abs = path.resolve(file);
	const rel = path.relative(runs, abs);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && abs.endsWith(".jsonl");
}

/** Parse a pi session JSONL file into its message entries (bad lines skipped). */
export function parseTranscriptJsonl(text: string): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
			if (entry.type === "message" && entry.message) out.push(entry.message);
		} catch {
			// partial trailing line while the worker still writes, or noise
		}
	}
	return out;
}

export class WorkerHub {
	private readonly records = new Map<number, WorkerRecord>();
	/** Worker ids a client is following (transcript pushes go out for these). */
	readonly open = new Set<number>();

	constructor(private readonly agentDir: string) {}

	/** Replace the worker list from a bridge `workers` event. Returns true when
	 *  the public summaries changed (the caller then refreshes the snapshot). */
	applyList(workers: BridgeWorker[]): boolean {
		let changed = false;
		const seen = new Set<number>();
		for (const w of workers) {
			if (typeof w?.id !== "number") continue;
			seen.add(w.id);
			const summary: WorkerRecord["summary"] = {
				id: w.id,
				toolCallId: typeof w.toolCallId === "string" ? w.toolCallId : undefined,
				role: String(w.role ?? ""),
				model: String(w.model ?? ""),
				task: String(w.task ?? ""),
				status: asStatus(w.status),
				activity: String(w.activity ?? ""),
				started: typeof w.started === "number" ? w.started : Date.now(),
				ended: typeof w.ended === "number" ? w.ended : undefined,
				recent: asStringList(w.recent),
				text: typeof w.text === "string" ? w.text : "",
			};
			const file = typeof w.transcript === "string" && w.transcript ? w.transcript : undefined;
			const rec = this.records.get(w.id);
			if (!rec) {
				this.records.set(w.id, { summary, transcriptFile: file, ids: new Map(), cache: new Map() });
				changed = true;
				continue;
			}
			if (file && file !== rec.transcriptFile) {
				rec.transcriptFile = file;
				rec.fileMessages = undefined;
				changed = true;
			}
			if (JSON.stringify(rec.summary) !== JSON.stringify(summary)) {
				rec.summary = summary;
				changed = true;
			}
		}
		// The extension clears its map on session restore (session_start /
		// session_tree) and republishes — drop anything it no longer reports
		// (deleting the current entry during Map iteration is well-defined).
		for (const id of this.records.keys()) {
			if (!seen.has(id)) {
				this.records.delete(id);
				this.open.delete(id);
				changed = true;
			}
		}
		return changed;
	}

	/** Attach live session state from a bridge `transcript` event. Returns
	 *  true when the worker is known (the caller may push to followers). */
	applyTranscript(workerId: number, messages: AgentMessage[], streaming: AgentMessage | null): boolean {
		const rec = this.records.get(workerId);
		if (!rec) return false;
		rec.live = { messages: Array.isArray(messages) ? messages : [], streaming: streaming ?? null };
		return true;
	}

	has(id: number): boolean {
		return this.records.has(id);
	}

	/** Public list in start order (what UiState.workers carries). */
	list(): UiWorker[] {
		return [...this.records.values()]
			.sort((a, b) => a.summary.id - b.summary.id)
			.map((r) => ({ ...r.summary, hasTranscript: !!r.live || !!r.transcriptFile }));
	}

	private serialize(rec: WorkerRecord, m: AgentMessage): UiMessage | null {
		const key = m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${fingerprint(m)}`;
		let n = rec.ids.get(key);
		if (n === undefined) {
			n = rec.ids.size + 1;
			rec.ids.set(key, n);
		}
		const cacheKey = `${key}#${n}`;
		const hit = rec.cache.get(cacheKey);
		if (hit) return hit;
		const ui = serializeMessage(m, n);
		if (ui) rec.cache.set(cacheKey, ui);
		return ui;
	}

	/** The transcript to show for one worker: live state when the extension
	 *  streams it, else the saved JSONL, else empty. Never throws. */
	async transcript(workerId: number): Promise<UiWorkerTranscript> {
		const rec = this.records.get(workerId);
		const empty: UiWorkerTranscript = { workerId, messages: [], streamingMessage: null, source: "none" };
		if (!rec) return empty;
		if (rec.live) {
			const messages = rec.live.messages.map((m) => this.serialize(rec, m)).filter((m): m is UiMessage => m !== null);
			const streamingMessage = rec.live.streaming ? serializeStreamingMessage(rec.live.streaming) : null;
			return { workerId, messages, streamingMessage, source: "live" };
		}
		if (!rec.transcriptFile || !isAllowedTranscriptPath(rec.transcriptFile, this.agentDir)) return empty;
		if (rec.fileMessages) return { workerId, messages: rec.fileMessages, streamingMessage: null, source: "file" };
		try {
			const text = await readFile(rec.transcriptFile, "utf8");
			const messages = parseTranscriptJsonl(text)
				.map((m) => this.serialize(rec, m))
				.filter((m): m is UiMessage => m !== null);
			if (isFinished(rec.summary.status)) rec.fileMessages = messages;
			return { workerId, messages, streamingMessage: null, source: "file" };
		} catch {
			return empty;
		}
	}
}

/** Cheap content fingerprint so same-role same-millisecond messages get
 *  distinct ids (mirrors agent-service's serializeCachedFor). */
function fingerprint(m: AgentMessage): string {
	const c = (m as { content?: unknown }).content;
	if (typeof c === "string") return `${c.length}:${c.slice(0, 32)}`;
	if (Array.isArray(c)) {
		const first = c[0] as { type?: string; text?: string; name?: string } | undefined;
		return `${c.length}:${first?.type ?? ""}:${(first?.text ?? first?.name ?? "").slice(0, 32)}`;
	}
	return "";
}
