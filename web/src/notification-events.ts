/** Live notification events delivered on the WebSocket.
 *
 * This module deliberately contains no snapshot/reconnect logic: notification
 * events are edge-triggered server messages, and the eventId is handed to the
 * notification service for cross-tab deduplication. The notify.ts API must
 * preserve that eventId as its keyed-delivery option and make both its service
 * worker and page-Notification fallback click targets use
 * `?notificationConversationId=<conversationId>`.
 */

export const NOTIFICATION_CONVERSATION_QUERY = "notificationConversationId";
export const NOTIFICATION_CLICK_EVENT = "dispatch:notification-click";

export interface NotificationClickMessage {
	type: "notification-click";
	conversationId: string;
}

/** Build the strict payload shared by service-worker and page fallback clicks. */
export function notificationClickMessage(conversationId: string): NotificationClickMessage | null {
	return typeof conversationId === "string" && conversationId.length > 0
		? { type: "notification-click", conversationId }
		: null;
}

/** Parse an untrusted postMessage/CustomEvent payload without accepting URLs. */
export function parseNotificationClickMessage(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const message = value as Partial<NotificationClickMessage>;
	const keys = Object.keys(message);
	return keys.length === 2 &&
		keys.includes("type") &&
		keys.includes("conversationId") &&
		message.type === "notification-click" &&
		typeof message.conversationId === "string" &&
		message.conversationId.length > 0
		? message.conversationId
		: null;
}

export type NotificationEventKind = "run-completed" | "input-required" | "run-failed";

export interface NotificationEvent {
	type: "notification_event";
	eventId: string;
	conversationId: string;
	kind: NotificationEventKind;
	projectName: string;
	sessionName?: string;
}

/** Defensive runtime check for the WebSocket boundary. */
export function isNotificationEvent(value: unknown): value is NotificationEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<NotificationEvent>;
	return (
		event.type === "notification_event" &&
		typeof event.eventId === "string" &&
		event.eventId.length > 0 &&
		typeof event.conversationId === "string" &&
		event.conversationId.length > 0 &&
		(event.kind === "run-completed" || event.kind === "input-required" || event.kind === "run-failed") &&
		typeof event.projectName === "string" &&
		event.projectName.length > 0 &&
		(event.sessionName === undefined || typeof event.sessionName === "string")
	);
}

const EVENT_COPY: Record<NotificationEventKind, { title: string; status: string }> = {
	"run-completed": { title: "Task finished", status: "completed" },
	"input-required": { title: "Needs your input", status: "waiting for input" },
	"run-failed": { title: "Task failed", status: "failed" },
};

export interface NotificationCopy {
	title: string;
	body: string;
}

/** Format only the privacy-approved fields: project, session, and status. */
export function formatNotificationEvent(event: NotificationEvent): NotificationCopy {
	const copy = EVENT_COPY[event.kind];
	const scope = event.sessionName ? `${event.projectName} · ${event.sessionName}` : event.projectName;
	return { title: copy.title, body: `${scope} · ${copy.status}` };
}

/** The server's stable event identity is the cross-tab deduplication key. */
export function notificationEventKey(event: NotificationEvent): string {
	return event.eventId;
}

/** Read, but do not trust, a notification click target from the app URL. */
export function notificationConversationIdFromUrl(url: string): string | null {
	try {
		const id = new URL(url, "http://notification.invalid").searchParams.get(NOTIFICATION_CONVERSATION_QUERY);
		return id && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

/**
 * Resolve a click only against conversations already known to this page.
 * Returning null is intentional: a notification click must never cause an
 * arbitrary conversation fetch or URL navigation.
 */
export function resolveNotificationConversation(
	url: string,
	availableConversationIds: Iterable<string>,
): string | null {
	const id = notificationConversationIdFromUrl(url);
	if (!id) return null;
	for (const availableId of availableConversationIds) if (availableId === id) return id;
	return null;
}

/** Remove a handled (or malformed) click parameter while preserving other URL state. */
export function withoutNotificationConversationId(url: string): string {
	try {
		const parsed = new URL(url, "http://notification.invalid");
		parsed.searchParams.delete(NOTIFICATION_CONVERSATION_QUERY);
		return parsed.href;
	} catch {
		return url;
	}
}
