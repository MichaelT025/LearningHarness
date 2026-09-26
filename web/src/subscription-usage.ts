/** Types and small, side-effect-free helpers for subscription usage UI. */

export type SubscriptionResponseStatus = "ready" | "disabled" | "unavailable";
export type SubscriptionProviderState = "ok" | "unavailable" | "unconfigured";
export type CreditUnit = "credits" | "USD";

export interface SubscriptionWindow {
	label: string;
	windowSeconds: number;
	usedPercent: number;
	resetsAt: string | null;
}

export interface SubscriptionCredit {
	label: string;
	remaining: number;
	unit: CreditUnit;
}

export interface SubscriptionProvider {
	providerId: string;
	displayName: string;
	state: SubscriptionProviderState;
	windows: SubscriptionWindow[];
	plan?: string;
	credits?: SubscriptionCredit[];
	fetchedAt: string | null;
	checkedAt: string;
	error?: string;
	retryAt?: string;
	stale?: boolean;
}

export interface SubscriptionResponse {
	status: SubscriptionResponseStatus;
	providers: SubscriptionProvider[];
	refreshAfterMs: number;
}

/** Keep provider values safe for both rendering and aria-valuenow. */
export function safePercent(value: unknown): number {
	const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
	return Math.min(100, Math.max(0, number));
}

export function usageLevel(percent: number): "ok" | "warning" | "critical" {
	const safe = safePercent(percent);
	if (safe >= 100) return "critical";
	if (safe >= 80) return "warning";
	return "ok";
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Decode the intentionally small API contract at the UI boundary. Invalid
 * provider rows are ignored rather than allowing one malformed row to break
 * the whole footer.
 */
export function parseSubscriptionResponse(value: unknown): SubscriptionResponse | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.status !== "ready" && raw.status !== "disabled" && raw.status !== "unavailable") return null;
	if (!Array.isArray(raw.providers)) return null;
	const providers: SubscriptionProvider[] = [];
	for (const item of raw.providers) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		if (typeof row.providerId !== "string" || typeof row.displayName !== "string") continue;
		const state =
			row.state === "ok" || row.state === "unavailable" || row.state === "unconfigured" ? row.state : "unavailable";
		const windows: SubscriptionWindow[] = Array.isArray(row.windows)
			? row.windows.flatMap((window): SubscriptionWindow[] => {
					if (!window || typeof window !== "object") return [];
					const candidate = window as Record<string, unknown>;
					if (typeof candidate.label !== "string") return [];
					return [
						{
							label: candidate.label,
							windowSeconds: Math.max(0, finiteNumber(candidate.windowSeconds)),
							usedPercent: safePercent(candidate.usedPercent),
							resetsAt: typeof candidate.resetsAt === "string" ? candidate.resetsAt : null,
						},
					];
				})
			: [];
		const credits: SubscriptionCredit[] | undefined = Array.isArray(row.credits)
			? row.credits.flatMap((credit): SubscriptionCredit[] => {
					if (!credit || typeof credit !== "object") return [];
					const candidate = credit as Record<string, unknown>;
					if (typeof candidate.label !== "string" || (candidate.unit !== "credits" && candidate.unit !== "USD"))
						return [];
					return [{ label: candidate.label, remaining: finiteNumber(candidate.remaining), unit: candidate.unit }];
				})
			: undefined;
		providers.push({
			providerId: row.providerId,
			displayName: row.displayName,
			state,
			windows,
			...(typeof row.plan === "string" ? { plan: row.plan } : {}),
			...(credits ? { credits } : {}),
			fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : null,
			checkedAt: typeof row.checkedAt === "string" ? row.checkedAt : "",
			...(typeof row.error === "string" ? { error: row.error } : {}),
			...(typeof row.retryAt === "string" ? { retryAt: row.retryAt } : {}),
			...(row.stale === true ? { stale: true } : {}),
		});
	}
	return {
		status: raw.status,
		providers,
		refreshAfterMs: Math.max(1, finiteNumber(raw.refreshAfterMs, 180_000)),
	};
}

function numberText(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Command Code exposes disjoint Included/Purchased/Free pools, all in credits. */
export function totalCommandCredits(provider: SubscriptionProvider): SubscriptionCredit | null {
	if (provider.providerId !== "command-code") return null;
	const pools = provider.credits?.filter((credit) => credit.unit === "credits");
	if (!pools?.length) return null;
	return {
		label: "Total credits",
		remaining: pools.reduce((sum, credit) => sum + credit.remaining, 0),
		unit: "credits",
	};
}

/** Format a credit using its API unit, never silently treating USD as credits. */
export function formatCredit(credit: Pick<SubscriptionCredit, "remaining" | "unit">): string {
	if (credit.unit === "USD") {
		return `$${credit.remaining.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}
	return `${numberText(credit.remaining)} credits`;
}

/** A local-only countdown used by an open popover; it does not poll the API. */
export function formatResetCountdown(resetsAt: string | null, now = Date.now()): string {
	if (!resetsAt) return "Starts on first use";
	const timestamp = Date.parse(resetsAt);
	if (!Number.isFinite(timestamp)) return "Reset time unavailable";
	const seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
	if (seconds === 0) return "Resetting soon";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const rest = seconds % 60;
	if (days) return `Resets in ${days}d ${hours}h`;
	if (hours) return `Resets in ${hours}h ${minutes}m`;
	if (minutes) return `Resets in ${minutes}m ${rest}s`;
	return `Resets in ${rest}s`;
}

function relativeAge(timestamp: string | null | undefined, now: number): string | null {
	if (!timestamp) return null;
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return null;
	const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Describe provider freshness without turning the local countdown into polling. */
export function formatFreshness(fetchedAt: string | null, checkedAt: string | null, now = Date.now()): string {
	const successful = relativeAge(fetchedAt, now);
	if (successful) return `Last successful update ${successful}`;
	const checked = relativeAge(checkedAt, now);
	if (checked) return `Last checked ${checked}; no successful update yet`;
	return "Last successful update unavailable";
}

/** Short, stable labels keep the footer useful when provider display names are long. */
export function providerShortName(provider: Pick<SubscriptionProvider, "providerId" | "displayName">): string {
	const id = provider.providerId.toLowerCase();
	if (id.includes("codex")) return "Codex";
	if (id === "go" || id === "opencode-go") return "Go";
	if (id.includes("command")) return "Command";
	return provider.displayName.length > 14 ? `${provider.displayName.slice(0, 13)}…` : provider.displayName;
}
