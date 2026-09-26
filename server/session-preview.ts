/**
 * Pure helpers behind the per-conversation message serialization cache and
 * the transcript-first preview of switch_session.
 *
 * Both live outside agent-service.ts so they need no runtime: the same
 * `serializeCachedInto` that produces a live conversation's UiMessage objects
 * can run over a transcript loaded with `SessionManager.open()` alone, and
 * the resulting cache is handed to the Conversation record once its runtime
 * exists — so the preview and the real snapshot share message ids AND object
 * references (the client-side identity walk sees "nothing changed").
 */
import type { UiMessage, UiState } from "./protocol.js";
import { serializeMessage, stripTransientRetryErrors, type AgentMessage } from "./serialize.js";

/** Serialization-cache cap per conversation (see serializeCachedInto): cached
 *  UiMessage objects are pure-function results, so eviction only costs a
 *  recompute on next access. Bounds memory for marathon sessions. */
export const UI_MESSAGE_CACHE_CAP = 4096;

/**
 * Per-conversation serialization state. Message ids derive from
 * (role, timestamp); two conversations can produce identical pairs, so a
 * cache must never be shared across conversations. A Conversation record
 * carries these four fields inline and satisfies this interface directly.
 */
export interface SerializeCache {
	msgIds: Map<string, number>;
	nextMsgId: number;
	/** Per-timestamp 1-based user-message seq (drives the `u-<ts>-<seq>` id suffix). */
	userSeqByTs: Map<number, number>;
	uiMessageCache: Map<string, UiMessage>;
}

export function newSerializeCache(): SerializeCache {
	return { msgIds: new Map(), nextMsgId: 1, userSeqByTs: new Map(), uiMessageCache: new Map() };
}

/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys. Text blocks are fingerprinted by a short hash of
 * their head (paths embedded in <file> tags can share long prefixes — e.g.
 * uploads created in the same millisecond differ only at the tail); image
 * payloads by data length (identical lengths within the same ms are far too
 * unlikely to matter).
 */
export function contentFingerprint(m: AgentMessage): string {
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as { type?: string; text?: string; data?: string };
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	const text = typeof first?.text === "string" ? first.text : "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < text.length && i < 512; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
	}
	return `txt:${h.toString(36)}:${text.length}`;
}

/** Serialize a persisted message with a STABLE id + cached object reference. */
export function serializeCachedInto(cache: SerializeCache, m: AgentMessage): UiMessage | null {
	// toolResult messages are keyed by toolCallId; everything else by
	// role+timestamp. A single prompt can emit several same-role messages
	// within the SAME millisecond (multiple attachment asides), so the
	// timestamp alone collides in the cache and only the first one renders
	// — append a cheap content fingerprint to keep them distinct while
	// staying stable across snapshots (content never changes once persisted).
	const key = m.role === "toolResult" ? `t:${m.toolCallId}` : `${m.role}:${m.timestamp}:${contentFingerprint(m)}`;
	let n = cache.msgIds.get(key);
	if (n === undefined) {
		n = cache.nextMsgId++;
		cache.msgIds.set(key, n);
	}
	const cacheKey = `${key}#${n}`;
	const cached = cache.uiMessageCache.get(cacheKey);
	if (cached) return cached;
	// User-message id suffix is a 1-based count of user messages sharing
	// this timestamp (that's what resolveUserMessageEntryId() expects). n is
	// a global per-conversation counter across ALL roles, so it can't be
	// reused as the seq — otherwise editing anything but the first question
	// fails to resolve ("找不到要编辑的消息").
	let seq = n;
	if (m.role === "user") {
		const ts = m.timestamp ?? 0;
		seq = (cache.userSeqByTs.get(ts) ?? 0) + 1;
		cache.userSeqByTs.set(ts, seq);
	}
	const msg = serializeMessage(m, seq);
	if (msg) {
		cache.uiMessageCache.set(cacheKey, msg);
		// Bound the cache (marathon sessions otherwise grow without limit;
		// single messages can reach TEXT_CAP = 200K chars). Map iteration is
		// insertion order, so dropping from the front evicts the oldest —
		// recent messages (the ones every snapshot touches) always survive.
		// Safe: a miss just recomputes an identical object on next access.
		let excess = cache.uiMessageCache.size - UI_MESSAGE_CACHE_CAP;
		while (excess-- > 0) {
			const oldest = cache.uiMessageCache.keys().next().value;
			if (oldest === undefined) break;
			cache.uiMessageCache.delete(oldest);
		}
	}
	return msg;
}

/** Serialize a whole transcript (the SessionContext message list) through
 *  `cache`, in order, dropping messages the serializer hides. Mirrors what
 *  messagesOf() does for a live conversation (minus the sig-reuse step). */
export function serializeTranscript(cache: SerializeCache, messages: readonly AgentMessage[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const m of messages) {
		const ui = serializeCachedInto(cache, m);
		if (ui) out.push(ui);
	}
	return stripTransientRetryErrors(out, false);
}

/** Everything buildPreviewState needs that only the caller knows. */
export interface PreviewStateInput {
	clientId: string;
	/** The transcript's own cwd (SessionManager.getCwd()) — the workspace the
	 *  conversation will switch to once its runtime is up. */
	cwd: string;
	sessionId: string;
	sessionFile: string;
	/** Id allocated for the conversation being booted (nextConversationId()). */
	conversationId: string;
	rev: number;
	version: number;
	messages: UiMessage[];
	/** Message entries in the transcript (getSessionStats().totalMessages). */
	totalMessages: number;
	/** From SessionContext: the model the transcript last ran with, if any. */
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	piConfigured: boolean;
	piAgentInstalled: boolean;
}

/**
 * Snapshot state for a conversation whose runtime is still booting. The
 * message list is final (it comes from the same transcript the runtime will
 * load); every runtime-derived field is a neutral placeholder that the real
 * snapshot overwrites: no streaming, empty queue/tools/workers, no stats
 * beyond the message count, thinking levels unknown. `model` is filled from
 * the transcript's model entry (name = raw id, vision unknown) so the top bar
 * doesn't flash "no model" before the real one arrives.
 */
export function buildPreviewState(input: PreviewStateInput): UiState {
	return {
		clientId: input.clientId,
		cwd: input.cwd,
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
		conversationId: input.conversationId,
		rev: input.rev,
		messages: input.messages,
		booting: true,
		streamingMessage: null,
		isStreaming: false,
		model: input.model
			? { id: input.model.modelId, name: input.model.modelId, provider: input.model.provider, vision: false }
			: null,
		thinkingLevel: input.thinkingLevel,
		availableThinkingLevels: [],
		queue: { steering: [], followUp: [] },
		retry: null,
		compaction: null,
		pendingQuestion: null,
		workers: [],
		tools: [],
		version: input.version,
		piConfigured: input.piConfigured,
		piAgentInstalled: input.piAgentInstalled,
		stats: {
			totalMessages: input.totalMessages,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
		},
	};
}
