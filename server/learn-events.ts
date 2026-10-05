/**
 * Versioned `learn:demo` event bridge (Phase-0 spike shape).
 *
 * The engine-side channel, the version/shape guard, and the inline pi
 * extension factory live HERE — `server/protocol.ts` stays types-only
 * (LearnEvent / learn_event message shapes, no runtime code).
 *
 * Wiring (see `ClientSession.makeRuntimeFactory` in agent-service.ts):
 * one factory instance is registered per runtime alongside the existing
 * persona extension. The bus subscription is registered ONCE at factory
 * time — subscribing inside `agent_start` would add a duplicate subscriber
 * on every prompt (2nd run forwards twice, 3rd three times, ...).
 * `agent_start` only emits. Each runtime owns its ExtensionAPI/bus, so a
 * fresh runtime never inherits another conversation's listeners; the
 * optional `isActive` gate additionally drops events from
 * inactive/background conversations so they never appear on the active chat.
 * No topic persistence: demo events are fire-and-forget per run.
 *
 * The per-run demo emit is opt-in (`demo: true`, wired to
 * LEARN_DEMO_EVENTS=1): it proves the round trip, but in a real tutoring
 * session a "bridge online" card on every turn is noise.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { LearnEvent } from "./protocol.js";

/** Channel the engine uses on `pi.events` for the Phase-0 demo event. */
export const LEARN_DEMO_CHANNEL = "learn:demo";

/** Payload message emitted once per run on `agent_start`. */
export const LEARN_DEMO_MESSAGE = "learn bridge online";

/** Runtime guard: only versioned, well-shaped learn events cross the bridge. */
export function isLearnEvent(data: unknown): data is LearnEvent {
	if (typeof data !== "object" || data === null) return false;
	const e = data as Record<string, unknown>;
	return e.version === 1 && e.type === "demo" && typeof e.message === "string";
}

/**
 * Inline pi extension wiring the learn event bridge for ONE runtime.
 * `forward` sends validated events to the socket (as `learn_event`
 * payloads); `isActive` (when given) must report whether this runtime's
 * conversation is still the active one — events arriving while it returns
 * false are dropped.
 */
export function makeLearnBridgeExtension(
	forward: (event: LearnEvent) => void,
	isActive?: () => boolean,
	options: { demo?: boolean } = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.events.on(LEARN_DEMO_CHANNEL, (data: unknown) => {
			// Version/shape gate: unversioned payloads never reach the client.
			if (!isLearnEvent(data)) return;
			if (isActive && !isActive()) return;
			forward(data);
		});
		if (!options.demo) return;
		pi.on("agent_start", () => {
			pi.events.emit(LEARN_DEMO_CHANNEL, {
				version: 1,
				type: "demo",
				message: LEARN_DEMO_MESSAGE,
			});
		});
	};
}
