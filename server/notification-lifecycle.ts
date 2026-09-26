import { randomUUID } from "node:crypto";
import type { ServerMessage } from "./protocol.js";

/** The stop reason which the SDK emits for an assistant message. */
export type AssistantStopReason = string | undefined;

export interface NotificationConversationContext {
	conversationId: string;
	projectName: string;
	sessionName?: string;
	/** The SDK's authoritative post-run state. */
	isIdle: boolean;
	/** Queues are checked in addition to isIdle as a defensive protocol guard. */
	queuedSteering?: readonly string[];
	queuedFollowUp?: readonly string[];
	/** A retry can be pending even while the final error message is visible. */
	retrying?: boolean;
	/** Worker summaries belonging to this conversation only. */
	workers?: readonly { status: string }[];
}

export interface NotificationLifecycleOptions {
	/** Injectable in tests; production uses the server-generated UUID. */
	newEventId?: () => string;
}

/**
 * Converts one SDK session's run lifecycle into at-most-one live notification.
 *
 * `agent_end` is deliberately only input to this state machine. A run is
 * authoritative only at `agent_settled`, after retries, continuations and
 * compaction have been exhausted. This is also why this helper does not react
 * to worker callbacks: worker completion is merely an input to the main
 * orchestrator, not a conversation result.
 */
export class NotificationLifecycle {
	private run: { finalStopReason?: AssistantStopReason; hasFinalAssistant: boolean; abortRequested: boolean } | null =
		null;
	private readonly newEventId: () => string;

	constructor(options: NotificationLifecycleOptions = {}) {
		this.newEventId = options.newEventId ?? randomUUID;
	}

	/** Start tracking a fresh top-level run. Continuations/retries share it. */
	agentStart(): void {
		if (!this.run) this.run = { hasFinalAssistant: false, abortRequested: false };
	}

	/** Remember the final assistant result for this run (including errors). */
	agentEnd(messages: readonly { role?: string; stopReason?: AssistantStopReason }[]): void {
		if (!this.run) return;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				this.run.finalStopReason = message.stopReason;
				this.run.hasFinalAssistant = true;
				break;
			}
		}
	}

	/** Mark a user Stop/abort. Aborted runs never produce a completion event. */
	abort(): void {
		if (this.run) this.run.abortRequested = true;
	}

	/**
	 * Finalize the run only when the SDK says the session is idle. Returning
	 * null leaves the run armed, which protects against a premature settle
	 * signal and lets a later authoritative settle finish it.
	 */
	settled(context: NotificationConversationContext): ServerMessage | null {
		const run = this.run;
		if (!run || !context.isIdle || !run.hasFinalAssistant) return null;
		if ((context.queuedSteering?.length ?? 0) > 0 || (context.queuedFollowUp?.length ?? 0) > 0) return null;
		if (context.retrying) return null;
		if (context.workers?.some((worker) => worker.status === "starting" || worker.status === "running")) return null;

		this.run = null;
		if (run.abortRequested || run.finalStopReason === "aborted") return null;
		const kind = run.finalStopReason === "error" ? "run-failed" : "run-completed";
		return {
			type: "notification_event",
			eventId: this.newEventId(),
			conversationId: context.conversationId,
			kind,
			projectName: context.projectName,
			...(context.sessionName ? { sessionName: context.sessionName } : {}),
		};
	}

	/** Session replacement/reset/disposal must not leak the previous run. */
	reset(): void {
		this.run = null;
	}
}

/** Emit an input-required event with the same strictly bounded payload. */
export function makeInputRequiredNotification(
	context: Pick<NotificationConversationContext, "conversationId" | "projectName" | "sessionName">,
	newEventId: () => string = randomUUID,
): ServerMessage {
	return {
		type: "notification_event",
		eventId: newEventId(),
		conversationId: context.conversationId,
		kind: "input-required",
		projectName: context.projectName,
		...(context.sessionName ? { sessionName: context.sessionName } : {}),
	};
}
