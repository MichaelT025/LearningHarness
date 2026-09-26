/**
 * Desktop / OS (PWA) notifications for pi-web-ui.
 *
 * Lightweight, frontend-only notifications via the browser Notification API.
 * They are routed through the registered service worker (reg.showNotification)
 * so they still appear when the installed PWA is running in the background /
 * minimised — exactly the "a session finished / needs your input while I'm in
 * another app" case from issue #13. No server-side web push (that would need a
 * subscription + VAPID + push endpoint; out of scope).
 *
 * Delivery is deliberately strict: a notification is allowed only when the
 * document is hidden OR the document has lost focus.  Window geometry, platform
 * detection, and idle time are diagnostic-only; they never create an exception
 * to that gate.
 *
 * `new Notification()` is a valid fallback in Chrome/Edge on Windows when no
 * service worker is registered / active yet (dev mode, first load after an
 * update). Both routes focus and select an existing conversation in place,
 * preserving any pending input dialog.
 *
 * There is a second Windows trap that cost a round of debugging: notifications
 * must NOT carry a `tag`. Windows replaces an existing toast that has the same
 * tag *silently* — no banner, no sound — and as long as one pi-web-ui toast is
 * still sitting in the notification centre, every later notification is
 * swallowed the same way (`showNotification` still resolves, so the page thinks
 * it worked). Empirically the user had to empty the notification centre before
 * each test; `renotify: true` did not help (Chromium's renotify does not reach
 * the Windows toast layer). Each notification is therefore its own toast — the
 * Action Center accumulates a few entries, which beats silent reminders.
 *
 * Windows toasts are additionally gated by the OS: the browser (or the
 * installed PWA) must be allowed under Settings → System → Notifications and
 * Focus assist must be off. Nothing in the page can override that, so the
 * settings UI shows a hint (`notifyWindowsHint`). For the hard cases there is a
 * diagnostic (`sendTestNotification`: route, error, whether the browser really
 * kept the notification, presence snapshot). Its settings button waits five
 * seconds so the user can switch away; it never bypasses the focus gate.
 */

import { appUrl } from "./base-url";
import { NOTIFICATION_CLICK_EVENT } from "./notification-events";

export interface NotifySettings {
	/** Master switch — kills every OS notification. */
	enabled: boolean;
}

const STORAGE_KEY = "pi-web-notify";

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { enabled: false };

/** Read persisted settings, falling back to defaults on any failure. */
export function loadNotifySettings(): NotifySettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_NOTIFY_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<NotifySettings>;
		return { enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NOTIFY_SETTINGS.enabled };
	} catch {
		return { ...DEFAULT_NOTIFY_SETTINGS };
	}
}

export function saveNotifySettings(settings: NotifySettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — notifications just won't persist
	}
}

export function notificationsSupported(): boolean {
	return typeof window !== "undefined" && "Notification" in window;
}

/** Why OS notifications are unavailable (null = available and usable). */
export type NotifyBlockReason = "insecure" | "unsupported";

/**
 * Classify *why* notifications are unavailable so the UI can say something
 * true instead of the blanket "this browser does not support notifications".
 *
 * The interesting case is `insecure`: Chromium only exposes the Notification
 * API in a secure context (https, or http on localhost/127.0.0.1/::1).
 * Opening pi-web-ui over plain http on a LAN IP or machine hostname — the
 * usual Windows "serve here, open it from another PC" setup — has no
 * `Notification` object at all even though the browser supports notifications
 * perfectly well; only the address is at fault. Fix = open via 127.0.0.1 or put
 * HTTPS in front (nginx/tailscale/caddy).
 */
export function notifyBlockReason(): NotifyBlockReason | null {
	if (notificationsSupported()) return null;
	if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
	return "unsupported";
}

/* ------------------------------------------------------------------ */
/* Presence: is the user actually watching this page?                  */
/* ------------------------------------------------------------------ */

/** Native window rectangle retained for diagnostics only. It is never used to
 * widen the strict notification delivery gate. */
export interface WindowRect {
	screenX: number;
	screenY: number;
	outerWidth: number;
	outerHeight: number;
}

/** Legacy diagnostic threshold. It is intentionally not consulted by the
 * notification policy; idle/minimized heuristics never permit delivery. */
export const NOTIFY_IDLE_GRACE_MS = 120_000;

/** Presence snapshot. Only `hasFocus` and `visibility` are policy inputs;
 * the remaining fields are retained for diagnostics/backward compatibility. */
export interface PresenceSignals {
	hasFocus: boolean;
	visibility: string;
	/** Diagnostic: window is minimised to the taskbar (native geometry says so). */
	minimized: boolean;
	/** Diagnostic milliseconds since the last real user interaction. */
	idleMs: number;
	/** Diagnostic platform flag; never an exception to the focus gate. */
	windows: boolean;
}

/**
 * Is this window collapsed to the taskbar?
 *
 * Pure function over the native window rectangle. Windows minimises by moving
 * the window to the Win32 "minimised" position (Chrome reports -32000, Edge
 * -21334) and collapsing `outerWidth/Height` to the title bar (108×20 /
 * 160×28); `hasFocus()` and `visibilityState` stay put and are therefore
 * useless here. The thresholds are deliberately far outside any real monitor
 * layout (three 4K monitors stacked leftwards reach ≈ -11520; a window can't
 * legitimately be 40px tall while being a browser window).
 */
export function isCollapsedWindow(rect: WindowRect): boolean {
	const { screenX, screenY, outerWidth, outerHeight } = rect;
	if (Number.isFinite(screenX) && offScreen(screenX)) return true;
	if (Number.isFinite(screenY) && offScreen(screenY)) return true;
	// 宽高都塌到标题栏大小才算（> 0 是必须的：无窗口环境如 headless 报 0×0，
	// 那是「量不到」而不是「最小化」）。
	return outerWidth > 0 && outerWidth <= 400 && outerHeight > 0 && outerHeight <= 40;
}

/** Far enough off-screen that no monitor layout can explain it. */
function offScreen(coordinate: number): boolean {
	return coordinate <= -10000;
}

/**
 * Whether the strict foreground gate suppresses a notification.
 *
 * The only allowed delivery states are `visibilityState === "hidden"` or
 * `hasFocus() === false`.  In particular, minimizing/idle timers are not
 * exceptions: if both standard signals say the page is foreground, we do not
 * show a toast.
 */
export function shouldSuppressNotify(presence: PresenceSignals): boolean {
	return presence.visibility !== "hidden" && presence.hasFocus;
}

/** The inverse of the strict foreground gate. */
export function shouldDeliverNotify(presence: PresenceSignals): boolean {
	return !shouldSuppressNotify(presence);
}

/* ------------------------------------------------------------------ */
/* User-activity tracking (diagnostics only; never a delivery exception)   */
/* ------------------------------------------------------------------ */

let lastActivityMs = Date.now();
let activityBound = false;

/** Record "the user just did something on this page". */
export function markActivity(): void {
	lastActivityMs = Date.now();
}

/** Milliseconds since the last recorded interaction. */
export function idleSinceLastActivityMs(): number {
	return Math.max(0, Date.now() - lastActivityMs);
}

/** One-time (cheap, passive) listeners; safe to call repeatedly. */
function bindActivityTracking(): void {
	if (activityBound || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
	activityBound = true;
	const options: AddEventListenerOptions = { passive: true, capture: true };
	for (const event of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus", "scroll"]) {
		window.addEventListener(event, markActivity, options);
	}
	if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
		document.addEventListener("visibilitychange", markActivity, options);
	}
}

/** True on Windows (used only in the diagnostic presence snapshot). */
export function isWindowsPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /windows/i.test(navigator.userAgent ?? "");
}

/** Snapshot the current presence signals (also used by the settings UI/诊断). */
export function currentPresence(): PresenceSignals {
	bindActivityTracking();
	if (typeof window === "undefined" || typeof document === "undefined") {
		return { hasFocus: true, visibility: "visible", minimized: false, idleMs: 0, windows: false };
	}
	return {
		hasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
		visibility: document.visibilityState ?? "",
		minimized: isCollapsedWindow({
			screenX: window.screenX,
			screenY: window.screenY,
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
		}),
		idleMs: idleSinceLastActivityMs(),
		windows: isWindowsPlatform(),
	};
}

/* ------------------------------------------------------------------ */
/* Showing notifications                                               */
/* ------------------------------------------------------------------ */

export function notificationPermission(): NotificationPermission {
	if (!notificationsSupported()) return "denied";
	return Notification.permission;
}

/** Request the notification permission. MUST be called from a user gesture
 *  (e.g. toggling the switch) or the browser rejects it. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!notificationsSupported()) return "denied";
	try {
		return await Notification.requestPermission();
	} catch {
		return "denied";
	}
}

/** Which route actually put the toast on screen (for diagnostics). */
export type NotifyPath = "sw" | "page" | "none";

export interface NotifyAttempt {
	path: NotifyPath;
	/** Failure detail when `path === "none"` (or the SW route that was skipped). */
	error?: string;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

/** Optional metadata for a notification event.
 *
 * `eventKey` is an application-stable identity (not a generated per-call id).
 * Keyed events are delivered at most once across tabs when Web Locks and
 * localStorage are available. `targetConversationId` is carried to the service
 * worker click handler; the current worker can focus the originating URL, while
 * conversation routing remains an app-level concern.
 */
export interface NotifyOptions {
	eventKey?: string;
	targetConversationId?: string;
	/** Alias accepted for callers that use the app's usual conversation naming. */
	conversationId?: string;
}

/** localStorage key used by the cross-tab consumed-event ledger. */
export const NOTIFY_CONSUMED_EVENTS_KEY = "pi-web-notify-consumed-events-v1";
/** One lock protects the whole ledger read/modify/write transaction. */
export const NOTIFY_EVENT_LOCK_NAME = "pi-web-notify-events-v1";
/** Event IDs are only a reconnect-deduplication cache, not permanent history. */
export const NOTIFY_EVENT_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
export const NOTIFY_EVENT_LEDGER_MAX_ENTRIES = 256;

function notificationOptions(body?: string, sticky = false, options?: NotifyOptions): NotificationOptions {
	const targetConversationId = options?.targetConversationId ?? options?.conversationId;
	return {
		body,
		// In-app sound cues handle the foreground case; OS notifications are
		// silent by default so they do not create a second audible channel.
		silent: true,
		// 测试通知用 sticky（requireInteraction）：横幅一出就不会自己滑走，人为
		// 点一下才消失 —— 一条「一秒就没了」的测试通知等于没测。
		requireInteraction: sticky,
		// appUrl keeps the icon path valid under nginx sub-path deployments
		// (e.g. /pi/); root deployments resolve to the exact same URL.
		icon: appUrl("/icons/icon-192.png"),
		badge: appUrl("/icons/icon-192.png"),
		// 故意**不**用 tag。Windows 上「同 tag 的新通知只是替换旧条目」是静默的
		// —— 没有横幅、没有提示音，而且系统通知中心里只要还躺着一条旧通知，
		// 后续每一条都会被无声替换掉（实测：手动清空通知中心后才能再弹一次；
		// 加 renotify: true 也救不回来 —— Chromium 的 renotify 到 Windows toast
		// 这层不起作用）。所以每条通知都是一个新 toast：一定提醒，代价只是通知
		// 中心里会累积几条。
		// Click target for the service worker's `notificationclick` handler
		// (brings the window back on Windows/Linux, where a toast click would
		// otherwise do nothing). `location.href` keeps PI_WEB_TOKEN intact.
		// App's notification-events helper consumes this query parameter after a
		// click and validates it against the loaded conversation roster.
		data: {
			url: typeof location !== "undefined" ? location.href : appUrl("/"),
			...(targetConversationId ? { notificationConversationId: targetConversationId } : {}),
		},
	};
}

/** Focus and select in place: reloading would discard a pending input dialog. */
function bindPageNotificationClick(notification: Notification, options: NotificationOptions): void {
	notification.onclick = () => {
		try {
			notification.close();
		} catch {
			// Best effort: some test/browser implementations omit close().
		}
		try {
			const win = typeof window !== "undefined" ? window : undefined;
			win?.focus();
			const conversationId = options.data?.notificationConversationId;
			if (typeof conversationId !== "string" || !conversationId) return;
			win?.dispatchEvent(
				new CustomEvent(NOTIFICATION_CLICK_EVENT, {
					detail: { type: "notification-click", conversationId },
				}),
			);
		} catch {
			// Notification clicks must never surface an unhandled navigation error.
		}
	};
}

/** A deliberately small structural type keeps the coordination code testable
 * without depending on a concrete browser implementation. */
type NotifyLocks = {
	request: (name: string, callback: () => Promise<unknown>) => Promise<unknown>;
};

function availableLocks(): NotifyLocks | null {
	try {
		const navigatorLike = (globalThis as unknown as { navigator?: { locks?: NotifyLocks } }).navigator;
		const locks = navigatorLike?.locks;
		return locks && typeof locks.request === "function" ? locks : null;
	} catch {
		return null;
	}
}

function availableStorage(): Storage | null {
	try {
		const storage = (globalThis as unknown as { localStorage?: Storage }).localStorage;
		return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" ? storage : null;
	} catch {
		return null;
	}
}

/** Read and compact the bounded timestamp ledger. A malformed/unreadable
 * ledger is an unsafe coordination state, so keyed delivery fails closed. */
interface ConsumedEventsRead {
	entries: Record<string, number>;
	changed: boolean;
}

function readConsumedEvents(storage: Storage, now = Date.now()): ConsumedEventsRead | null {
	try {
		const raw = storage.getItem(NOTIFY_CONSUMED_EVENTS_KEY);
		if (!raw) return { entries: Object.create(null) as Record<string, number>, changed: false };
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const all: Record<string, number> = Object.create(null) as Record<string, number>;
		let changed = false;
		for (const [key, value] of Object.entries(parsed)) {
			// `true` is accepted once to migrate the pre-timestamp ledger format.
			const timestamp = value === true ? now : value;
			if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) return null;
			if (timestamp < now - NOTIFY_EVENT_LEDGER_TTL_MS) {
				changed = true;
				continue;
			}
			all[key] = timestamp;
			if (value === true) changed = true;
		}
		const newest = Object.entries(all).sort((a, b) => b[1] - a[1]);
		if (newest.length > NOTIFY_EVENT_LEDGER_MAX_ENTRIES) changed = true;
		const entries: Record<string, number> = Object.create(null) as Record<string, number>;
		for (const [key, timestamp] of newest.slice(0, NOTIFY_EVENT_LEDGER_MAX_ENTRIES)) entries[key] = timestamp;
		return { entries, changed };
	} catch {
		return null;
	}
}

function writeConsumedEvents(storage: Storage, entries: Record<string, number>): boolean {
	try {
		storage.setItem(NOTIFY_CONSUMED_EVENTS_KEY, JSON.stringify(entries));
		return true;
	} catch {
		return false;
	}
}

/** Mark one key consumed and verify the write. The single global Web Lock held
 * by the caller makes the entire shared-ledger transaction atomic between tabs. */
function consumeEvent(storage: Storage, eventKey: string): "consumed" | "already" | "unavailable" {
	const read = readConsumedEvents(storage);
	if (!read) return "unavailable";
	if (read.entries[eventKey] !== undefined) {
		if (read.changed && !writeConsumedEvents(storage, read.entries)) return "unavailable";
		return "already";
	}
	read.entries[eventKey] = Date.now();
	const boundedEntries: Record<string, number> = Object.create(null) as Record<string, number>;
	for (const [key, timestamp] of Object.entries(read.entries)
		.sort((a, b) => b[1] - a[1])
		.slice(0, NOTIFY_EVENT_LEDGER_MAX_ENTRIES)) {
		boundedEntries[key] = timestamp;
	}
	if (!writeConsumedEvents(storage, boundedEntries)) return "unavailable";
	const written = readConsumedEvents(storage);
	return written?.entries[eventKey] !== undefined ? "consumed" : "unavailable";
}

/**
 * Put a toast on screen, right now, whatever the presence signals say.
 * Prefers the service worker (works while the PWA is backgrounded, and its
 * click handler brings the window back) and falls back to a plain page
 * notification — including when the SW route *throws* (registration present but
 * not active yet: first load / right after an update), which used to swallow
 * the notification entirely. Never throws.
 */
async function showNow(
	title: string,
	body?: string,
	sticky = false,
	options?: NotifyOptions,
	/** Rechecked after every asynchronous step and immediately before showing. */
	mayDeliver: () => boolean = () => shouldDeliverNotify(currentPresence()),
): Promise<NotifyAttempt> {
	if (!notificationsSupported()) return { path: "none", error: "unsupported" };
	if (!loadNotifySettings().enabled) return { path: "none", error: "notifications disabled" };
	if (Notification.permission !== "granted") return { path: "none", error: `permission: ${Notification.permission}` };
	// This check is intentionally also inside showNow: keyed delivery may have
	// waited for another tab's lock, during which focus can change.
	if (!mayDeliver())
		return { path: "none", error: "foreground: switch away from this page to test notification delivery" };

	const notification = notificationOptions(body, sticky, options);
	let swError: string | undefined;
	try {
		const reg = await navigator.serviceWorker?.getRegistration();
		if (!loadNotifySettings().enabled || Notification.permission !== "granted")
			return { path: "none", error: "notifications disabled or permission revoked before delivery" };
		if (!mayDeliver()) return { path: "none", error: "foreground: page regained focus before delivery" };
		if (reg?.active && typeof reg.showNotification === "function") {
			await reg.showNotification(title, notification);
			return { path: "sw" };
		}
		swError = reg ? "service worker not active" : "no service worker registration";
	} catch (err) {
		swError = describeError(err);
	}
	// A failed SW attempt can fall back, but must not bypass the strict gate or
	// a setting/permission change that happened while the SW was being awaited.
	if (!loadNotifySettings().enabled || Notification.permission !== "granted")
		return { path: "none", error: "notifications disabled or permission revoked before fallback delivery" };
	if (!mayDeliver()) return { path: "none", error: "foreground: page regained focus before fallback delivery" };
	try {
		const pageNotification = new Notification(title, notification);
		bindPageNotificationClick(pageNotification, notification);
		return { path: "page", error: swError };
	} catch (err) {
		return { path: "none", error: `${swError ?? "service worker unavailable"}; page: ${describeError(err)}` };
	}
}

/** Deliver a keyed event while holding its cross-tab lock. The event is
 * consumed before the focus decision, so a focused-tab skip cannot replay when
 * another tab later receives the same event. Missing/unsafe coordination fails
 * closed rather than risking duplicate delivery. */
async function notifyKeyed(title: string, body: string | undefined, options: NotifyOptions): Promise<void> {
	if (typeof options.eventKey !== "string" || options.eventKey.length === 0) return;
	const locks = availableLocks();
	const storage = availableStorage();
	if (!locks || !storage) return;
	try {
		await locks.request(NOTIFY_EVENT_LOCK_NAME, async () => {
			// The lock may have been queued while settings or permission changed.
			// Do not consume an event that was never eligible for delivery.
			if (!loadNotifySettings().enabled || Notification.permission !== "granted") return;
			const state = consumeEvent(storage, options.eventKey as string);
			if (state !== "consumed")
				return { path: "none", error: state === "already" ? "event already consumed" : "event ledger unavailable" };
			if (!shouldDeliverNotify(currentPresence()))
				return { path: "none", error: "foreground: event consumed without delivery" };
			await showNow(title, body, false, options);
			return { path: "none" };
		});
	} catch {
		// Lock implementation errors (including a denied/unsupported manager)
		// must never turn a best-effort notification into an unsafe duplicate.
	}
}

/** Show an OS notification when enabled + granted AND the user is not watching
 * this page. Existing two-argument calls remain valid. Keyed calls require
 * safe Web Locks + localStorage coordination and otherwise fail closed. */
export async function notify(title: string, body?: string, options?: NotifyOptions): Promise<void> {
	if (!notificationsSupported()) return;
	if (!loadNotifySettings().enabled) return;
	if (options?.eventKey !== undefined) {
		await notifyKeyed(title, body, options);
		return;
	}
	if (!shouldDeliverNotify(currentPresence())) return;
	await showNow(title, body, false, options);
}

/** Handle for the settings-panel diagnostics: with no `tag` on our
 *  notifications (see `notificationOptions` — a tag makes Windows replace the
 *  old toast *silently*), this asks the browser what it still holds for this
 *  origin (`held`). */
export interface NotifyDiagnostics extends NotifyAttempt {
	permission: NotificationPermission;
	supported: boolean;
	secureContext: boolean;
	/** A service worker registration exists (its `active` state decides the route). */
	serviceWorker: boolean;
	/** Would `notify()` swallow a notification right now? */
	suppressed: boolean;
	presence: PresenceSignals;
	/**
	 * Notifications the *browser* still holds for this origin right after
	 * showing (null = could not ask). `> 0` means the browser accepted and is
	 * displaying it, so a missing banner is an OS/browser-display setting
	 * (Windows banner toggles, Edge quiet notifications, Do not disturb); `0`
	 * means the browser dropped it and the browser-side settings are at fault.
	 */
	held: number | null;
}

/**
 * Fire one diagnostic notification, but never bypass the strict focus gate.
 * The settings UI schedules this test and tells the user to switch away; if it
 * is called while focused, it returns a useful no-op result instead of a
 * foreground toast. This remains an unkeyed diagnostic and therefore does not
 * participate in the event ledger.
 */
export async function sendTestNotification(title: string, body?: string): Promise<NotifyDiagnostics> {
	const presence = currentPresence();
	const base = {
		permission: notificationPermission(),
		supported: notificationsSupported(),
		secureContext: typeof window !== "undefined" ? window.isSecureContext !== false : false,
		serviceWorker: false,
		suppressed: shouldSuppressNotify(presence),
		presence,
		held: null as number | null,
	};
	if (!base.supported) return { ...base, path: "none", error: "unsupported" };
	if (!loadNotifySettings().enabled) return { ...base, path: "none", error: "notifications disabled" };
	if (!shouldDeliverNotify(presence)) {
		return {
			...base,
			path: "none",
			error: "foreground: switch away from this page to test notification delivery",
		};
	}
	let reg: ServiceWorkerRegistration | undefined;
	try {
		reg = await navigator.serviceWorker?.getRegistration();
		base.serviceWorker = !!reg;
	} catch {
		// ignore — only used as a hint in the UI
	}
	const attempt = await showNow(title, body, true, undefined, () => shouldDeliverNotify(currentPresence()));
	// Ask the browser whether it really kept the notification: this is what
	// separates "the OS/browser never took it" from "it is sitting in the
	// notification centre but the banner was suppressed".
	if (attempt.path === "sw" && reg?.active && typeof reg.getNotifications === "function") {
		try {
			base.held = (await reg.getNotifications()).length;
		} catch {
			base.held = null;
		}
	}
	return { ...base, ...attempt };
}
