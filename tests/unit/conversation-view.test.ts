/**
 * Instant-click client state: the optimistic new chat, the per-conversation
 * snapshot cache (LRU) and the switch-pending flag, both as pure helpers
 * (conversation-view.ts) and through the use-chat reducer.
 */
import { describe, expect, it } from "vitest";
import type { ConversationSummary, UiState } from "../../web/src/types.js";
import {
	OPTIMISTIC_CONVERSATION_ID,
	cacheSnapshot,
	pruneSnapshots,
	recentConversationIds,
	sendBlocked,
	syntheticNewChat,
} from "../../web/src/conversation-view.js";
import { chatReducer, initialChatState, type ChatAction, type ChatState } from "../../web/src/use-chat.js";

function snapshot(conversationId: string, over: Partial<UiState> = {}): UiState {
	return {
		clientId: "client",
		cwd: "/proj/a",
		sessionId: `sess-${conversationId}`,
		sessionFile: `/sessions/${conversationId}.jsonl`,
		conversationId,
		rev: 1,
		messages: [
			{ id: `${conversationId}-m1`, role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		] as UiState["messages"],
		streamingMessage: null,
		isStreaming: false,
		model: { id: "m", name: "M", provider: "p", vision: true },
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		queue: { steering: [], followUp: [] },
		workers: [],
		tools: ["read"],
		version: 1,
		piConfigured: true,
		piAgentInstalled: true,
		stats: {
			totalMessages: 1,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: 0.01,
			contextUsage: { tokens: 15, contextWindow: 1000, percent: 1.5 },
		},
		...over,
	};
}

/** snapshot_delta that chains onto rev `baseRev` of `conversationId`. */
function delta(conversationId: string, baseRev: number, over: Partial<UiState> = {}): ChatAction {
	const { messages: _messages, ...light } = snapshot(conversationId, { rev: baseRev + 1, ...over });
	return {
		type: "snapshot_delta",
		msg: {
			type: "snapshot_delta",
			conversationId,
			rev: baseRev + 1,
			baseRev,
			state: light,
			appended: [{ id: `${conversationId}-m2`, role: "assistant", content: [], timestamp: 2 }] as UiState["messages"],
		},
	};
}

function conv(id: string): ConversationSummary {
	return { id, title: id, cwd: "/proj/a", messageCount: 1, isStreaming: false };
}

/** Reducer state with conversation `id` displayed (and cached). */
function shown(id: string, base: ChatState = initialChatState()): ChatState {
	return chatReducer(base, { type: "snapshot", state: snapshot(id) });
}

describe("syntheticNewChat", () => {
	it("keeps the light fields, resets the conversation-bound ones, flags booting", () => {
		const cur = snapshot("c1");
		const view = syntheticNewChat(cur, null);
		expect(view).not.toBeNull();
		expect(view!.conversationId).toBe(OPTIMISTIC_CONVERSATION_ID);
		expect(view!.booting).toBe(true);
		expect(view!.messages).toEqual([]);
		expect(view!.isStreaming).toBe(false);
		expect(view!.sessionFile).toBeUndefined();
		expect(view!.cwd).toBe("/proj/a");
		expect(view!.model).toBe(cur.model);
		expect(view!.tools).toBe(cur.tools);
		expect(view!.stats.totalMessages).toBe(0);
	});

	it("targets the given cwd and needs a snapshot to derive from", () => {
		expect(syntheticNewChat(snapshot("c1"), "/proj/b")!.cwd).toBe("/proj/b");
		expect(syntheticNewChat(null, "/proj/b")).toBeNull();
	});
});

describe("sendBlocked", () => {
	it("blocks on any of optimistic / switch pending / server booting", () => {
		expect(sendBlocked({ optimistic: false, switchPending: null })).toBe(false);
		expect(sendBlocked({ optimistic: false, switchPending: null, booting: false })).toBe(false);
		expect(sendBlocked({ optimistic: true, switchPending: null })).toBe(true);
		expect(sendBlocked({ optimistic: false, switchPending: "c2" })).toBe(true);
		expect(sendBlocked({ optimistic: false, switchPending: null, booting: true })).toBe(true);
	});
});

describe("snapshot cache helpers", () => {
	it("is an LRU bounded to max entries, newest last", () => {
		let cache = new Map<string, UiState>();
		for (const id of ["a", "b", "c"]) cache = cacheSnapshot(cache, snapshot(id), 2);
		expect([...cache.keys()]).toEqual(["b", "c"]);
		// Re-caching an existing id moves it to the newest end.
		cache = cacheSnapshot(cache, snapshot("b", { rev: 2 }), 2);
		expect([...cache.keys()]).toEqual(["c", "b"]);
		expect(cache.get("b")!.rev).toBe(2);
	});

	it("never caches booting previews or the optimistic chat", () => {
		let cache = new Map<string, UiState>();
		cache = cacheSnapshot(cache, snapshot("p", { booting: true }));
		cache = cacheSnapshot(cache, syntheticNewChat(snapshot("x"), null)!);
		expect(cache.size).toBe(0);
	});

	it("prunes ids that left the conversation list (same Map when unchanged)", () => {
		let cache = new Map<string, UiState>();
		for (const id of ["a", "b"]) cache = cacheSnapshot(cache, snapshot(id));
		expect(pruneSnapshots(cache, [conv("a"), conv("b")])).toBe(cache);
		expect([...pruneSnapshots(cache, [conv("b")]).keys()]).toEqual(["b"]);
	});

	it("lists the displayed conversation first, then the newest cached ones", () => {
		let cache = new Map<string, UiState>();
		for (const id of ["a", "b", "c", "d"]) cache = cacheSnapshot(cache, snapshot(id));
		expect(recentConversationIds("b", cache, 3)).toEqual(["b", "d", "c"]);
		expect(recentConversationIds("z", cache, 2)).toEqual(["z", "d"]);
		expect(recentConversationIds(null, cache, 2)).toEqual(["d", "c"]);
	});

	it("never parks an empty conversation (its welcome screen would linger hidden)", () => {
		let cache = new Map<string, UiState>();
		cache = cacheSnapshot(cache, snapshot("full"));
		cache = cacheSnapshot(cache, snapshot("blank", { messages: [] }));
		expect(recentConversationIds("cur", cache, 3)).toEqual(["cur", "full"]);
		// the displayed one is always listed, even when empty
		expect(recentConversationIds("blank", cache, 3)).toEqual(["blank", "full"]);
	});
});

describe("chatReducer: optimistic new chat", () => {
	it("shows an empty booting chat with nothing active in the sidebar", () => {
		const s = chatReducer(shown("c1"), { type: "optimistic_new_chat", cwd: "/proj/b" });
		expect(s.optimisticNewChat).not.toBeNull();
		expect(s.optimisticNewChat!.view.messages).toEqual([]);
		expect(s.optimisticNewChat!.view.booting).toBe(true);
		expect(s.optimisticNewChat!.view.cwd).toBe("/proj/b");
		expect(s.activeConversationId).toBe("");
		// The server snapshot underneath is untouched (restored on timeout).
		expect(s.state!.conversationId).toBe("c1");
	});

	it("is a no-op before the first snapshot", () => {
		const base = initialChatState();
		expect(chatReducer(base, { type: "optimistic_new_chat", cwd: null })).toBe(base);
	});

	it("clears on the next snapshot — the new chat or the old one after a failure", () => {
		const pending = chatReducer(shown("c1"), { type: "optimistic_new_chat", cwd: null });
		const ok = chatReducer(pending, { type: "snapshot", state: snapshot("c2", { messages: [] }) });
		expect(ok.optimisticNewChat).toBeNull();
		expect(ok.activeConversationId).toBe("c2");
		const failed = chatReducer(pending, { type: "snapshot", state: snapshot("c1") });
		expect(failed.optimisticNewChat).toBeNull();
		expect(failed.activeConversationId).toBe("c1");
	});

	it("keeps the sidebar inactive across an interim conversations push", () => {
		const pending = chatReducer(shown("c1"), { type: "optimistic_new_chat", cwd: null });
		const s = chatReducer(pending, { type: "conversations", conversations: [conv("c1")], activeId: "c1" });
		expect(s.activeConversationId).toBe("");
		expect(s.optimisticNewChat).not.toBeNull();
	});

	it("times out only for the request it was armed for", () => {
		const first = chatReducer(shown("c1"), { type: "optimistic_new_chat", cwd: null });
		const second = chatReducer(first, { type: "optimistic_new_chat", cwd: null });
		expect(second.optimisticNewChat!.seq).toBe(first.optimisticNewChat!.seq + 1);
		expect(chatReducer(second, { type: "optimistic_timeout", seq: first.optimisticNewChat!.seq })).toBe(second);
		const cleared = chatReducer(second, { type: "optimistic_timeout", seq: second.optimisticNewChat!.seq });
		expect(cleared.optimisticNewChat).toBeNull();
		expect(cleared.activeConversationId).toBe("c1");
	});

	it("a refused worktree_add clears it (no snapshot will follow)", () => {
		const pending = chatReducer(shown("c1"), { type: "optimistic_new_chat", cwd: null });
		const s = chatReducer(pending, {
			type: "worktree_result",
			result: { type: "worktree_result", op: "add", ok: false, path: "/proj/a", error: "nope" },
		});
		expect(s.optimisticNewChat).toBeNull();
		expect(s.activeConversationId).toBe("c1");
	});
});

describe("chatReducer: snapshot cache + instant switch", () => {
	it("caches every displayed snapshot and delta, pruned by the conversation list", () => {
		let s = shown("c1");
		s = shown("c2", s);
		expect([...s.snapshotsById.keys()]).toEqual(["c1", "c2"]);
		s = chatReducer(s, delta("c2", 1, { isStreaming: true }));
		expect(s.state!.rev).toBe(2);
		expect(s.state!.isStreaming).toBe(true);
		expect(s.snapshotsById.get("c2")!.messages).toHaveLength(2);
		s = chatReducer(s, { type: "conversations", conversations: [conv("c2")], activeId: "c2" });
		expect([...s.snapshotsById.keys()]).toEqual(["c2"]);
	});

	it("paints the cached snapshot at once and holds sends until the server confirms", () => {
		let s = shown("c1");
		s = shown("c2", s);
		const c1 = s.snapshotsById.get("c1")!;
		s = chatReducer(s, { type: "switch_conversation", id: "c1" });
		expect(s.state).toBe(c1);
		expect(s.state!.booting).toBeUndefined(); // cached server data is not faked as booting
		expect(s.switchPending).toBe("c1");
		expect(s.activeConversationId).toBe("c1");
		expect(sendBlocked({ booting: s.state!.booting, optimistic: false, switchPending: s.switchPending })).toBe(true);
		// Server confirms: same messages reference → memoized rows stay put.
		const confirmed = chatReducer(s, { type: "snapshot", state: { ...c1, rev: 5 } });
		expect(confirmed.switchPending).toBeNull();
		expect(confirmed.state!.messages).toBe(c1.messages);
	});

	it("without a cache entry only the highlight moves; the old view stays", () => {
		const s = chatReducer(shown("c1"), { type: "switch_conversation", id: "c9" });
		expect(s.state!.conversationId).toBe("c1");
		expect(s.switchPending).toBe("c9");
		expect(s.activeConversationId).toBe("c9");
		const back = chatReducer(s, { type: "switch_timeout", id: "c9" });
		expect(back.switchPending).toBeNull();
		expect(back.activeConversationId).toBe("c1");
	});

	it("a delta for the conversation just left refreshes its cache entry, not the view", () => {
		let s = shown("c1");
		s = shown("c2", s);
		s = chatReducer(s, { type: "switch_conversation", id: "c1" });
		s = chatReducer(s, delta("c2", 1));
		expect(s.state!.conversationId).toBe("c1");
		expect(s.snapshotsById.get("c2")!.rev).toBe(2);
		expect(s.snapshotsById.get("c2")!.messages).toHaveLength(2);
	});

	it("a booting preview renders like a snapshot and is replaced, never cached", () => {
		let s = shown("c1");
		s = chatReducer(s, { type: "snapshot", state: snapshot("c3", { booting: true, model: null }) });
		expect(s.state!.booting).toBe(true);
		expect(s.activeConversationId).toBe("c3");
		expect(s.snapshotsById.has("c3")).toBe(false);
		s = chatReducer(s, { type: "snapshot", state: snapshot("c3") });
		expect(s.state!.booting).toBeUndefined();
		expect(s.snapshotsById.has("c3")).toBe(true);
	});
});
