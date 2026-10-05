/**
 * learn:demo event bridge tests (fake ExtensionAPI — no models, no disk, no network).
 * Covers the version/shape guard and the single-forwarding lifecycle:
 * subscribe once at factory time, one demo emit per agent_start, no
 * per-run subscriber leak, and the isActive gate for background conversations.
 */
import { describe, expect, it, vi } from "vitest";
import {
	isLearnEvent,
	LEARN_DEMO_CHANNEL,
	LEARN_DEMO_MESSAGE,
	makeLearnBridgeExtension,
} from "../../server/learn-events.js";

/** Controllable fake pi ExtensionAPI (bus + lifecycle hooks only). */
function makeFakePi() {
	const hooks = new Map<string, Array<(...args: never[]) => void>>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on: (event: string, handler: (...args: never[]) => void) => {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				const list = bus.get(channel) ?? [];
				list.push(handler);
				bus.set(channel, list);
			},
			emit: vi.fn((channel: string, data: unknown) => {
				for (const h of bus.get(channel) ?? []) h(data);
			}),
		},
	};
	return {
		pi: pi as never,
		emit: pi.events.emit,
		subscribers: (channel: string) => bus.get(channel) ?? [],
		fireAgentStart: () => {
			for (const h of hooks.get("agent_start") ?? []) h();
		},
		publish: (channel: string, data: unknown) => {
			for (const h of bus.get(channel) ?? []) h(data);
		},
	};
}

describe("isLearnEvent", () => {
	it("accepts versioned demo events and rejects everything else", () => {
		expect(isLearnEvent({ version: 1, type: "demo", message: "x" })).toBe(true);
		expect(isLearnEvent({ version: 2, type: "demo", message: "x" })).toBe(false);
		expect(isLearnEvent({ type: "demo", message: "x" })).toBe(false);
		expect(isLearnEvent({ version: 1, type: "demo" })).toBe(false);
		expect(isLearnEvent({ version: 1, type: "demo", message: 42 })).toBe(false);
		expect(isLearnEvent(null)).toBe(false);
		expect(isLearnEvent("learn:demo")).toBe(false);
	});
});

describe("makeLearnBridgeExtension", () => {
	it("emits no demo by default but still forwards events from the engine", () => {
		const forwarded: unknown[] = [];
		const factory = makeLearnBridgeExtension((e) => forwarded.push(e));
		const fake = makeFakePi();

		factory(fake.pi);
		fake.fireAgentStart();
		expect(fake.emit).not.toHaveBeenCalled();
		expect(forwarded).toEqual([]);
		fake.publish(LEARN_DEMO_CHANNEL, { version: 1, type: "demo", message: "from the engine" });
		expect(forwarded).toEqual([{ version: 1, type: "demo", message: "from the engine" }]);
	});

	it("subscribes once at factory time, emits a demo per agent_start, forwards validated events", () => {
		const forwarded: unknown[] = [];
		const factory = makeLearnBridgeExtension((e) => forwarded.push(e), undefined, { demo: true });
		const fake = makeFakePi();

		factory(fake.pi);
		// Single bus subscription registered at factory time (before any run).
		expect(fake.subscribers(LEARN_DEMO_CHANNEL)).toHaveLength(1);
		// Fire agent_start.
		fake.fireAgentStart();
		expect(fake.emit).toHaveBeenCalledWith(LEARN_DEMO_CHANNEL, {
			version: 1,
			type: "demo",
			message: LEARN_DEMO_MESSAGE,
		});
		// The self-emit round-trips through the subscriber and is forwarded.
		expect(forwarded).toEqual([{ version: 1, type: "demo", message: LEARN_DEMO_MESSAGE }]);
		// Unversioned payloads are dropped.
		fake.publish(LEARN_DEMO_CHANNEL, { type: "demo" });
		expect(forwarded).toHaveLength(1);
	});

	it("second agent_start yields exactly 2 forwards, not 3 (no per-run subscriber leak)", () => {
		const forwarded: unknown[] = [];
		const factory = makeLearnBridgeExtension((e) => forwarded.push(e), undefined, { demo: true });
		const fake = makeFakePi();

		factory(fake.pi);
		fake.fireAgentStart();
		fake.fireAgentStart();
		// One forward per run; the subscriber count stays at exactly one.
		expect(fake.subscribers(LEARN_DEMO_CHANNEL)).toHaveLength(1);
		expect(forwarded).toHaveLength(2);
	});

	it("drops events while isActive reports a background conversation", () => {
		const forwarded: unknown[] = [];
		let active = true;
		const factory = makeLearnBridgeExtension(
			(e) => forwarded.push(e),
			() => active,
			{ demo: true },
		);
		const fake = makeFakePi();

		factory(fake.pi);
		fake.fireAgentStart();
		expect(forwarded).toHaveLength(1);
		// Backgrounded: the run's own demo emit is gated at forward time.
		active = false;
		fake.fireAgentStart();
		fake.publish(LEARN_DEMO_CHANNEL, { version: 1, type: "demo", message: "bg" });
		expect(forwarded).toHaveLength(1);
		// Re-activated: forwarding resumes without re-registering.
		active = true;
		fake.fireAgentStart();
		expect(forwarded).toHaveLength(2);
		expect(fake.subscribers(LEARN_DEMO_CHANNEL)).toHaveLength(1);
	});
});
