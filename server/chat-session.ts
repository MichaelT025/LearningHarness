/**
 * Phase-0 per-socket chat session over the pi SDK.
 *
 * - One SDK `AgentSession` per WebSocket (in-memory transcript: spike only,
 *   no persistence across reconnects).
 * - Streams `message_update` / `text_delta` deltas to the socket.
 * - `prompt()` resolves with `done` carrying `getLastAssistantText()`.
 * - Concurrent prompts are refused (single in-flight run per socket).
 * - The inline `learn` bridge extension subscribes to `pi.events`
 *   `learn:demo` once at factory time, emits one demo event per `agent_start`,
 *   and forwards validated events to the socket as `learn_event` payloads.
 *
 * `createChatSession()` takes injectable session creation so tests can pass a
 * fake SDK session without loading models or touching disk.
 *
 * SDK baseline: @earendil-works/pi-coding-agent 0.87.1
 * (createAgentSession, DefaultResourceLoader extensionFactories,
 * SessionManager.inMemory, session.subscribe message_update).
 */
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	isLearnEvent,
	LEARN_DEMO_CHANNEL,
	type LearnEvent,
	type ServerMessage,
} from "./protocol.js";

/** Minimal structural surface of an assistant message for failure inspection. */
export interface AssistantMessageLike {
	role: string;
	stopReason?: string;
	errorMessage?: string;
}

/** Minimal structural surface of AgentSession used by the bridge (test fakes it). */
export interface SdkSessionLike {
	subscribe(listener: (event: SessionEventLike) => void): () => void;
	prompt(text: string): Promise<unknown>;
	abort(): Promise<unknown>;
	dispose(): void;
	getLastAssistantText(): string | undefined;
	/** Live transcript (`session.messages`); absent on older fakes. */
	messages?: AssistantMessageLike[];
}

/**
 * Inspect the authoritative last assistant message after a resolved prompt.
 * The SDK can resolve `prompt()` while the finalized message carries
 * `stopReason: "error"` (e.g. retries exhausted) — that must surface as an
 * `error` payload, never a `done`. Returns the failure message or null.
 */
export function lastAssistantError(session: SdkSessionLike): string | null {
	const messages = session.messages;
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		if (m.stopReason === "error") {
			const detail = m.errorMessage?.trim();
			return detail ? detail : "assistant run failed";
		}
		return null;
	}
	return null;
}

/** Structural subset of AgentSessionEvent relevant to the bridge. */
export interface SessionEventLike {
	type: string;
	assistantMessageEvent?: { type: string; delta?: string };
}

/** Injectable SDK entry point (defaults to the real createAgentSession). */
export interface ChatSessionDeps {
	createSession: (
		cwd: string,
		learnExtension: ExtensionFactory,
	) => Promise<SdkSessionLike>;
}

export const defaultDeps: ChatSessionDeps = {
	createSession: async (cwd, learnExtension) => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			extensionFactories: [learnExtension],
		});
		// REQUIRED: createAgentSession only reloads a loader it creates itself
		// (SDK dist/core/sdk.js); a caller-supplied loader must be reloaded or
		// extensionFactories (including the learn bridge) never load.
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		return session as unknown as SdkSessionLike;
	},
};

/**
 * Inline pi extension wiring the learn event bridge for ONE socket.
 * `forward` is the per-socket sender (closure over the WebSocket).
 *
 * The bus subscription is registered ONCE at factory time: subscribing inside
 * `agent_start` would add a duplicate subscriber on every prompt (2nd run
 * would forward twice, 3rd three times, ...). `agent_start` only emits.
 */
export function makeLearnBridgeExtension(
	forward: (event: LearnEvent) => void,
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.events.on(LEARN_DEMO_CHANNEL, (data: unknown) => {
			// Version/shape gate: unversioned payloads never reach the client.
			if (isLearnEvent(data)) forward(data);
		});
		pi.on("agent_start", () => {
			pi.events.emit(LEARN_DEMO_CHANNEL, {
				version: 1,
				type: "demo",
				message: "learn bridge online",
			});
		});
	};
}

export class ChatSession {
	private readonly send: (msg: ServerMessage) => void;
	private session: SdkSessionLike | null = null;
	private unsubscribe: (() => void) | null = null;
	private running = false;
	private disposed = false;

	constructor(send: (msg: ServerMessage) => void) {
		this.send = send;
	}

	/** Create the SDK session and subscribe to streaming deltas. */
	async start(cwd: string, deps: ChatSessionDeps = defaultDeps): Promise<void> {
		if (this.disposed) throw new Error("session disposed");
		const learnExtension = makeLearnBridgeExtension((event) => {
			this.send({ type: "learn_event", event });
		});
		const session = await deps.createSession(cwd, learnExtension);
		if (this.disposed) {
			session.dispose();
			return;
		}
		this.session = session;
		this.unsubscribe = session.subscribe((event) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent?.type === "text_delta" &&
				typeof event.assistantMessageEvent.delta === "string" &&
				event.assistantMessageEvent.delta.length > 0
			) {
				this.send({ type: "delta", text: event.assistantMessageEvent.delta });
			}
		});
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Send a prompt; resolves via done/error messages on the socket. */
	async prompt(text: string): Promise<void> {
		const session = this.session;
		if (!session) {
			this.send({ type: "error", message: "session not ready" });
			return;
		}
		if (this.running) {
			this.send({ type: "error", message: "a prompt is already running" });
			return;
		}
		this.running = true;
		try {
			await session.prompt(text);
			const failure = lastAssistantError(session);
			if (failure !== null) {
				this.send({ type: "error", message: failure });
			} else {
				this.send({ type: "done", text: session.getLastAssistantText() ?? "" });
			}
		} catch (err) {
			this.send({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.running = false;
		}
	}

	/** Abort the in-flight run (best effort; errors are swallowed). */
	async abort(): Promise<void> {
		try {
			await this.session?.abort();
		} catch {
			// Best effort: the run may already have settled.
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.unsubscribe?.();
		} catch {
			// ignore
		}
		this.unsubscribe = null;
		try {
			this.session?.dispose();
		} catch {
			// ignore
		}
		this.session = null;
	}
}

/** One-shot helper: build, start, and return a ChatSession. */
export async function createChatSession(
	send: (msg: ServerMessage) => void,
	cwd: string,
	deps: ChatSessionDeps = defaultDeps,
): Promise<ChatSession> {
	const chat = new ChatSession(send);
	await chat.start(cwd, deps);
	return chat;
}
