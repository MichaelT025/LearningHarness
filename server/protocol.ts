/**
 * Phase-0 chat bridge protocol (shared server <-> frontend).
 *
 * Frontend imports TYPES ONLY from this module (no runtime SDK imports).
 * Baseline: Dispatch-WebUI 8dc1df5 (server/protocol.ts), reduced to the
 * Phase-0 spike surface: prompt/abort in, ready/delta/done/error/learn_event out.
 */

export interface PromptClientMessage {
	type: "prompt";
	text: string;
}

export interface AbortClientMessage {
	type: "abort";
}

export type ClientMessage = PromptClientMessage | AbortClientMessage;

export interface ReadyServerMessage {
	type: "ready";
	model: string | null;
}

export interface DeltaServerMessage {
	type: "delta";
	text: string;
}

export interface DoneServerMessage {
	type: "done";
	text: string;
}

export interface ErrorServerMessage {
	type: "error";
	message: string;
}

export interface LearnEvent {
	version: 1;
	type: "demo";
	message: string;
}

export interface LearnEventServerMessage {
	type: "learn_event";
	event: LearnEvent;
}

export type ServerMessage =
	| ReadyServerMessage
	| DeltaServerMessage
	| DoneServerMessage
	| ErrorServerMessage
	| LearnEventServerMessage;

/** Channel the engine uses on `pi.events` for the Phase-0 demo event. */
export const LEARN_DEMO_CHANNEL = "learn:demo";

/** Runtime guard: only versioned, well-shaped learn events cross the bridge. */
export function isLearnEvent(data: unknown): data is LearnEvent {
	if (typeof data !== "object" || data === null) return false;
	const e = data as Record<string, unknown>;
	return e.version === 1 && e.type === "demo" && typeof e.message === "string";
}
