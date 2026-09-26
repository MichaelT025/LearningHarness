/**
 * Pure helpers behind the "every click answers instantly" client state
 * (zero React, unit-tested): the optimistic empty chat shown while the server
 * boots a new runtime, the per-conversation snapshot cache that makes a
 * sidebar switch paint before the server confirms it, and the one predicate
 * that decides whether the composer may send right now.
 *
 * Client-side state machine (all fields live in use-chat's ChatState):
 *
 *   optimisticNewChat  set by newChat(cwd) / worktree_add / "/new" — the view
 *                      is a synthetic empty UiState (booting: true); cleared
 *                      by the next `snapshot` (any conversation: the server
 *                      switches on success and re-snapshots the old chat on
 *                      failure), by a failed worktree_add result, or by the
 *                      15 s safety timeout.
 *   switchPending      set by switchConversation(id) — when a cached snapshot
 *                      of `id` exists it is displayed at once; cleared by the
 *                      next `snapshot` or the 15 s timeout.
 *   state.booting      the SERVER's transcript-first preview (switch_session);
 *                      rendered like any snapshot, replaced by the real one.
 *
 * Sending is blocked while any of the three is set (see sendBlocked).
 */
import type { ConversationSummary, UiState } from "./types";

/** conversationId of the synthetic optimistic chat (never a server id). */
export const OPTIMISTIC_CONVERSATION_ID = "optimistic-new-chat";

/** Cached snapshots kept per client (LRU: oldest entry evicted first). */
export const SNAPSHOT_CACHE_MAX = 8;

/** Safety timeout for optimistic / switch-pending state (matches LeftPanel's
 *  pendingTarget highlight). */
export const OPTIMISTIC_TIMEOUT_MS = 15_000;

/**
 * The empty conversation the client shows the instant a new chat is requested.
 * Derived from the current snapshot so the light fields (model, thinking
 * level, tools, piConfigured …) stay plausible; only the conversation-bound
 * fields are reset. Returns null before the first snapshot (nothing to derive
 * from — the boot-wait placeholder is already the right view).
 */
export function syntheticNewChat(current: UiState | null, cwd: string | null | undefined): UiState | null {
	if (!current) return null;
	return {
		...current,
		cwd: cwd || current.cwd,
		sessionId: "",
		sessionFile: undefined,
		conversationId: OPTIMISTIC_CONVERSATION_ID,
		rev: 0,
		messages: [],
		booting: true,
		streamingMessage: null,
		isStreaming: false,
		queue: { steering: [], followUp: [] },
		errorMessage: undefined,
		retry: null,
		compaction: null,
		pendingQuestion: null,
		workers: [],
		stats: {
			...current.stats,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { ...current.stats.contextUsage, tokens: null, percent: null },
		},
	};
}

/** Whether the composer must refuse to send: the runtime behind the displayed
 *  conversation is not confirmed yet (optimistic new chat, cached snapshot
 *  awaiting the server's switch, or the server's own booting preview). */
export function sendBlocked(view: { booting?: boolean; optimistic: boolean; switchPending: string | null }): boolean {
	return view.optimistic || view.switchPending !== null || view.booting === true;
}

/**
 * Remember `state` as the latest snapshot of its conversation. Map insertion
 * order is the LRU order (a re-insert moves the entry to the newest end);
 * over `max` entries the oldest is evicted. Booting previews are not cached:
 * they are placeholders the real snapshot replaces, and a failed boot would
 * leave a conversation that never existed in the cache.
 */
export function cacheSnapshot(
	cache: ReadonlyMap<string, UiState>,
	state: UiState,
	max = SNAPSHOT_CACHE_MAX,
): Map<string, UiState> {
	const next = new Map(cache);
	if (state.booting || state.conversationId === OPTIMISTIC_CONVERSATION_ID) return next;
	next.delete(state.conversationId);
	next.set(state.conversationId, state);
	while (next.size > max) {
		const oldest = next.keys().next().value;
		if (oldest === undefined) break;
		next.delete(oldest);
	}
	return next;
}

/** Drop cached snapshots of conversations that are no longer open. Returns
 *  the same Map when nothing changed (callers keep the reference). */
export function pruneSnapshots(
	cache: Map<string, UiState>,
	conversations: readonly ConversationSummary[],
): Map<string, UiState> {
	const open = new Set(conversations.map((c) => c.id));
	let changed = false;
	for (const id of cache.keys()) if (!open.has(id)) changed = true;
	if (!changed) return cache;
	const next = new Map<string, UiState>();
	for (const [id, s] of cache) if (open.has(id)) next.set(id, s);
	return next;
}

/** Ids of the conversations whose message lists stay mounted: the displayed
 *  one first, then the most recently viewed cached ones, `n` in total. */
export function recentConversationIds(
	current: string | null,
	cache: ReadonlyMap<string, UiState>,
	n: number,
): string[] {
	const out: string[] = [];
	if (current) out.push(current);
	// Map iteration is oldest → newest; walk from the newest end. A parked
	// list only earns its keep when there is something to re-show: an empty
	// chat rebuilds instantly, and its welcome screen must not linger hidden
	// in the DOM next to the visible one.
	const ids = [...cache.keys()];
	for (let i = ids.length - 1; i >= 0 && out.length < n; i--) {
		const id = ids[i];
		if (out.includes(id)) continue;
		if ((cache.get(id)?.messages.length ?? 0) === 0) continue;
		out.push(id);
	}
	return out;
}
