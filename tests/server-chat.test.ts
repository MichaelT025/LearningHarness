/**
 * Focused Phase-0 bridge tests: ChatSession + learn bridge extension with a
 * fake SDK session (no models, no disk, no network).
 *
 * Run once the package manifest + vitest exist (`npm run typecheck` / `vitest`).
 */
import { describe, expect, it, vi } from "vitest";
import { ChatSession, lastAssistantError, makeLearnBridgeExtension } from "../server/chat-session.js";
import { isLearnEvent } from "../server/protocol.js";
import type { ServerMessage } from "../server/protocol.js";
import type { SessionEventLike, SdkSessionLike } from "../server/chat-session.js";

/** Controllable fake SDK session. */
function makeFakeSession() {
	const listeners = new Set<(event: SessionEventLike) => void>();
	let lastText: string | undefined = "fake answer";
	let promptCalls = 0;
	const session: SdkSessionLike = {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		prompt: async (_text: string) => {
			promptCalls += 1;
		},
		abort: async () => {},
		dispose: () => {
			listeners.clear();
		},
		getLastAssistantText: () => lastText,
	};
	return {
		session,
		emit: (event: SessionEventLike) => {
			for (const l of [...listeners]) l(event);
		},
		get promptCalls() {
			return promptCalls;
		},
		setLastText: (t: string | undefined) => (lastText = t),
	};
}

function makeDeps(fake: ReturnType<typeof makeFakeSession>) {
	return {
		createSession: async () => fake.session,
	};
}

describe("ChatSession", () => {
	it("streams text_delta events as delta messages", async () => {
		const sent: ServerMessage[] = [];
		const fake = makeFakeSession();
		const chat = new ChatSession((m) => sent.push(m));
		await chat.start("/tmp", makeDeps(fake));

		fake.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hel" },
		});
		fake.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "lo" },
		});
		// Non-delta events are ignored.
		fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
		fake.emit({ type: "agent_end" });

		expect(sent).toEqual([
			{ type: "delta", text: "hel" },
			{ type: "delta", text: "lo" },
		]);
		chat.dispose();
	});

	it("prompt resolves with done carrying getLastAssistantText()", async () => {
		const sent: ServerMessage[] = [];
		const fake = makeFakeSession();
		fake.setLastText("final answer");
		const chat = new ChatSession((m) => sent.push(m));
		await chat.start("/tmp", makeDeps(fake));

		await chat.prompt("hello");
		expect(fake.promptCalls).toBe(1);
		expect(sent).toEqual([{ type: "done", text: "final answer" }]);
		chat.dispose();
	});

	it("refuses a concurrent prompt while one is running", async () => {
		const sent: ServerMessage[] = [];
		const fake = makeFakeSession();
		const chat = new ChatSession((m) => sent.push(m));
		await chat.start("/tmp", makeDeps(fake));

		// Never-resolving prompt keeps `running` true.
		fake.session.prompt = async () => new Promise<void>(() => {});
		const first = chat.prompt("one");
		await chat.prompt("two");
		expect(sent).toEqual([{ type: "error", message: "a prompt is already running" }]);
		chat.dispose();
		void first;
	});

	it("sends error instead of done when the finalized assistant message failed", async () => {
		const sent: ServerMessage[] = [];
		const fake = makeFakeSession();
		fake.session.messages = [
			{ role: "user" },
			{ role: "assistant", stopReason: "error", errorMessage: "upstream 429" },
		];
		const chat = new ChatSession((m) => sent.push(m));
		await chat.start("/tmp", makeDeps(fake));

		await chat.prompt("hi");
		expect(sent).toEqual([{ type: "error", message: "upstream 429" }]);
		chat.dispose();
	});

	it("sends done when the finalized assistant message stopped cleanly", async () => {
		const sent: ServerMessage[] = [];
		const fake = makeFakeSession();
		fake.setLastText("fine");
		fake.session.messages = [
			{ role: "assistant", stopReason: "error", errorMessage: "stale retry" },
			{ role: "assistant", stopReason: "stop" },
		];
		const chat = new ChatSession((m) => sent.push(m));
		await chat.start("/tmp", makeDeps(fake));

		await chat.prompt("hi");
		expect(sent).toEqual([{ type: "done", text: "fine" }]);
		chat.dispose();
	});

	describe("lastAssistantError", () => {
		const sess = (messages?: { role: string; stopReason?: string; errorMessage?: string }[]) => ({
			subscribe: () => () => {},
			prompt: async () => {},
			abort: async () => {},
			dispose: () => {},
			getLastAssistantText: () => "",
			...(messages === undefined ? {} : { messages }),
		});

		it("returns null without a transcript", () => {
			expect(lastAssistantError(sess())).toBeNull();
		});

		it("returns null when no assistant message exists", () => {
			expect(lastAssistantError(sess([{ role: "user" }]))).toBeNull();
		});

		it("falls back when errorMessage is absent or blank", () => {
			expect(lastAssistantError(sess([{ role: "assistant", stopReason: "error" }]))).toBe(
				"assistant run failed",
			);
			expect(
				lastAssistantError(sess([{ role: "assistant", stopReason: "error", errorMessage: "  " }])),
			).toBe("assistant run failed");
		});

		it("ignores aborted/length finals and skips tool chatter", () => {
			expect(lastAssistantError(sess([{ role: "assistant", stopReason: "aborted" }]))).toBeNull();
			expect(
				lastAssistantError(
					sess([
						{ role: "assistant", stopReason: "error", errorMessage: "old" },
						{ role: "toolResult" },
					]),
				),
			).toBe("old");
		});
	});

	it("surfaces prompt failures as error messages", async () => {
		const sent: ServerMessage[] = [];
		const fake = makeFakeSession();
		fake.session.prompt = async () => {
			throw new Error("boom");
		};
		const chat = new ChatSession((m) => sent.push(m));
		await chat.start("/tmp", makeDeps(fake));

		await chat.prompt("hi");
		expect(sent).toEqual([{ type: "error", message: "boom" }]);
		chat.dispose();
	});
});

describe("learn bridge extension", () => {
	it("subscribes once at factory time, emits a demo per agent_start, forwards validated events", () => {
		const forwarded: unknown[] = [];
		const factory = makeLearnBridgeExtension((e) => forwarded.push(e));

		const handlers = new Map<string, Array<(...args: never[]) => void>>();
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => void) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
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

		factory(pi as never);
		// Single bus subscription registered at factory time (before any run).
		expect(bus.get("learn:demo")?.length).toBe(1);
		// Fire agent_start.
		for (const h of handlers.get("agent_start") ?? []) h();
		expect(pi.events.emit).toHaveBeenCalledWith("learn:demo", {
			version: 1,
			type: "demo",
			message: "learn bridge online",
		});
		// The self-emit round-trips through the subscriber and is forwarded.
		expect(forwarded).toEqual([
			{ version: 1, type: "demo", message: "learn bridge online" },
		]);
		// Unversioned payloads are dropped.
		for (const h of bus.get("learn:demo") ?? []) h({ type: "demo" });
		expect(forwarded).toHaveLength(1);
	});

	it("second agent_start yields exactly 2 forwards, not 3 (no per-run subscriber leak)", () => {
		const forwarded: unknown[] = [];
		const factory = makeLearnBridgeExtension((e) => forwarded.push(e));

		const handlers = new Map<string, Array<(...args: never[]) => void>>();
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const pi = {
			on: (event: string, handler: (...args: never[]) => void) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			events: {
				on: (channel: string, handler: (data: unknown) => void) => {
					const list = bus.get(channel) ?? [];
					list.push(handler);
					bus.set(channel, list);
				},
				emit: (channel: string, data: unknown) => {
					for (const h of bus.get(channel) ?? []) h(data);
				},
			},
		};

		factory(pi as never);
		const fireStart = () => {
			for (const h of handlers.get("agent_start") ?? []) h();
		};
		fireStart();
		fireStart();
		// One forward per run; the subscriber count stays at exactly one.
		expect(bus.get("learn:demo")?.length).toBe(1);
		expect(forwarded).toHaveLength(2);
	});

	it("isLearnEvent validates version and shape", () => {
		expect(isLearnEvent({ version: 1, type: "demo", message: "x" })).toBe(true);
		expect(isLearnEvent({ version: 2, type: "demo", message: "x" })).toBe(false);
		expect(isLearnEvent({ type: "demo", message: "x" })).toBe(false);
		expect(isLearnEvent({ version: 1, type: "demo" })).toBe(false);
		expect(isLearnEvent(null)).toBe(false);
		expect(isLearnEvent("learn:demo")).toBe(false);
	});
});
