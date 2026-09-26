import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiAlertCircle, FiRefreshCw } from "react-icons/fi";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { withToken } from "../auth-token";
import { appUrl } from "../base-url";
import {
	formatCredit,
	formatFreshness,
	formatResetCountdown,
	parseSubscriptionResponse,
	safePercent,
	totalCommandCredits,
	type SubscriptionProvider,
	type SubscriptionResponse,
	usageLevel,
} from "../subscription-usage";
import "../css/subscriptions.css";

export interface SubscriptionUsageProps {
	clientId: string;
	ready: boolean;
}

const POLL_MS = 180_000;
const responseCache = new Map<string, SubscriptionResponse>();

function emptyResponse(status: SubscriptionResponse["status"]): SubscriptionResponse {
	return { status, providers: [], refreshAfterMs: POLL_MS };
}

function requestUrl(clientId: string): string {
	return withToken(appUrl(`/api/subscriptions?clientId=${encodeURIComponent(clientId)}`));
}

function retryRemaining(retryAt: string | undefined, now: number): number {
	if (!retryAt) return 0;
	const at = Date.parse(retryAt);
	return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

function retryText(seconds: number): string {
	if (seconds <= 0) return "";
	if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
	return `${seconds}s`;
}

function providerHasUsage(provider: SubscriptionProvider): boolean {
	return provider.windows.length > 0 || Boolean(provider.plan) || Boolean(provider.credits?.length);
}

export function SubscriptionUsage({ clientId, ready }: SubscriptionUsageProps) {
	const [data, setData] = useState<SubscriptionResponse | null>(() => responseCache.get(clientId) ?? null);
	const dataClientIdRef = useRef(clientId);
	const [openProviderId, setOpenProviderId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [requesting, setRequesting] = useState(false);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
	const dataRef = useRef(data);
	const controllerRef = useRef<AbortController | null>(null);
	const pollTimerRef = useRef<number | null>(null);
	const inFlightRef = useRef(false);
	const requestNumberRef = useRef(0);
	const mountedRef = useRef(false);
	const schedulePollRef = useRef<() => void>(() => undefined);
	const requestRef = useRef<(providerId?: string) => void>(() => undefined);

	useEffect(() => {
		dataRef.current = data;
	}, [data]);

	const clientChanged = dataClientIdRef.current !== clientId;
	if (clientChanged) dataClientIdRef.current = clientId;
	const renderedData = !ready ? null : clientChanged ? (responseCache.get(clientId) ?? null) : data;
	const providers = useMemo(
		() => (renderedData?.providers ?? []).filter((provider) => provider.state !== "unconfigured"),
		[renderedData],
	);
	const openProvider = providers.find((provider) => provider.providerId === openProviderId) ?? null;

	// The countdown belongs to an open popover, not to API freshness polling.
	useEffect(() => {
		if (!openProvider) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [openProvider]);

	const load = useCallback(
		async (providerId?: string) => {
			if (!ready || !clientId || !mountedRef.current || inFlightRef.current) return;
			const current = dataRef.current;
			if (providerId) {
				const selected = current?.providers.find((provider) => provider.providerId === providerId);
				if (retryRemaining(selected?.retryAt, Date.now()) > 0) return;
			}
			if (pollTimerRef.current !== null) {
				window.clearTimeout(pollTimerRef.current);
				pollTimerRef.current = null;
			}
			const controller = new AbortController();
			controllerRef.current = controller;
			const requestNumber = ++requestNumberRef.current;
			inFlightRef.current = true;
			setRequesting(true);
			setRequestError(null);
			if (providerId) setRefreshing(true);
			else if (!current) setLoading(true);
			try {
				const response = await fetch(requestUrl(clientId), {
					method: providerId ? "POST" : "GET",
					headers: providerId ? { "Content-Type": "application/json" } : undefined,
					body: providerId ? JSON.stringify({ providerId }) : undefined,
					signal: controller.signal,
				});
				if (!response.ok) throw new Error(`Subscription request failed (${response.status})`);
				const parsed = parseSubscriptionResponse(await response.json());
				if (!parsed) throw new Error("Subscription response was invalid");
				if (!mountedRef.current || controller.signal.aborted || requestNumber !== requestNumberRef.current) return;
				responseCache.set(clientId, parsed);
				dataRef.current = parsed;
				setData(parsed);
			} catch (error) {
				if (!mountedRef.current || controller.signal.aborted || requestNumber !== requestNumberRef.current) return;
				const message = error instanceof Error ? error.message : "Unable to check subscriptions";
				setRequestError(message);
				// Keep the last useful bars visible when a refresh fails, but make
				// their stale state explicit in text as well as in the DOM.
				const previous = dataRef.current;
				if (previous) {
					const stale: SubscriptionResponse = {
						...previous,
						providers: previous.providers.map((provider) => ({ ...provider, stale: true })),
					};
					dataRef.current = stale;
					responseCache.set(clientId, stale);
					setData(stale);
				} else {
					const unavailable = emptyResponse("unavailable");
					dataRef.current = unavailable;
					setData(unavailable);
				}
			} finally {
				if (requestNumber === requestNumberRef.current) {
					setLoading(false);
					setRefreshing(false);
					setRequesting(false);
					inFlightRef.current = false;
					if (mountedRef.current) schedulePollRef.current();
				}
			}
		},
		[clientId, ready],
	);

	useEffect(() => {
		mountedRef.current = true;
		requestNumberRef.current++;
		controllerRef.current?.abort();
		inFlightRef.current = false;
		if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
		pollTimerRef.current = null;
		setOpenProviderId(null);
		setRequestError(null);
		setLoading(false);
		setRefreshing(false);
		setRequesting(false);
		const cached = responseCache.get(clientId);
		dataRef.current = ready ? (cached ?? null) : emptyResponse("disabled");
		setData(dataRef.current);
		requestRef.current = (providerId?: string) => void load(providerId);
		if (!ready) {
			return () => {
				mountedRef.current = false;
				requestNumberRef.current++;
				controllerRef.current?.abort();
			};
		}

		const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
		const schedulePoll = () => {
			if (!mountedRef.current || !visible() || pollTimerRef.current !== null) return;
			const delay = Math.max(1, dataRef.current?.refreshAfterMs ?? POLL_MS);
			pollTimerRef.current = window.setTimeout(() => {
				pollTimerRef.current = null;
				if (visible()) void load();
			}, delay);
		};
		schedulePollRef.current = schedulePoll;
		const onVisibility = () => {
			if (!visible()) {
				if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
				pollTimerRef.current = null;
				if (inFlightRef.current) {
					requestNumberRef.current++;
					inFlightRef.current = false;
					setRequesting(false);
					setLoading(false);
					setRefreshing(false);
					controllerRef.current?.abort();
					controllerRef.current = null;
				}
				return;
			}
			void load();
		};
		document.addEventListener("visibilitychange", onVisibility);
		if (visible()) void load();
		return () => {
			mountedRef.current = false;
			requestNumberRef.current++;
			document.removeEventListener("visibilitychange", onVisibility);
			if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
			pollTimerRef.current = null;
			inFlightRef.current = false;
			controllerRef.current?.abort();
			controllerRef.current = null;
		};
	}, [clientId, load, ready]);

	useEffect(() => {
		if (openProviderId && !providers.some((provider) => provider.providerId === openProviderId))
			setOpenProviderId(null);
	}, [openProviderId, providers]);

	useEffect(() => {
		const onOutsidePress = (event: Event) => {
			if (openProviderId && rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenProviderId(null);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !openProviderId) return;
			const previous = buttonRefs.current.get(openProviderId);
			setOpenProviderId(null);
			window.setTimeout(() => previous?.focus(), 0);
		};
		document.addEventListener("pointerdown", onOutsidePress);
		document.addEventListener("mousedown", onOutsidePress);
		document.addEventListener("click", onOutsidePress);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onOutsidePress);
			document.removeEventListener("mousedown", onOutsidePress);
			document.removeEventListener("click", onOutsidePress);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openProviderId]);

	const status = renderedData?.status ?? (ready ? "loading" : "disabled");
	const retrySeconds = retryRemaining(openProvider?.retryAt, now);
	const totalCredits = openProvider ? totalCommandCredits(openProvider) : null;

	return (
		<div className="subscription-usage" ref={rootRef}>
			{openProvider && (
				<section
					id={`subscription-popover-${openProvider.providerId}`}
					className="subscription-popover"
					role="dialog"
					aria-labelledby="subscription-provider-name"
				>
					<div className="subscription-popover-head">
						<div className="subscription-provider-heading">
							<span className="subscription-provider-mark" aria-hidden="true">
								<ProviderBrandIcon providerId={openProvider.providerId} className="subscription-provider-icon" />
							</span>
							<div className="subscription-provider-heading-copy">
								<h2 id="subscription-provider-name">{openProvider.displayName}</h2>
								{openProvider.plan && <span className="subscription-plan">{openProvider.plan}</span>}
							</div>
						</div>
						<button
							type="button"
							className="subscription-refresh"
							onClick={() => requestRef.current(openProvider.providerId)}
							disabled={requesting || retrySeconds > 0}
							title={retrySeconds > 0 ? `Refresh (retry in ${retryText(retrySeconds)})` : "Refresh"}
							aria-label={`Refresh ${openProvider.displayName} usage`}
							aria-busy={refreshing}
						>
							<FiRefreshCw
								className={refreshing ? "subscription-refresh-icon is-refreshing" : "subscription-refresh-icon"}
								aria-hidden="true"
							/>
						</button>
					</div>
					{openProvider.stale && <p className="subscription-stale">Showing last known usage; refresh failed.</p>}
					{openProvider.state === "unavailable" && (
						<p className="subscription-message">This provider is configured but currently unavailable.</p>
					)}
					{openProvider.windows.map((window) => {
						const percent = safePercent(window.usedPercent);
						const level = usageLevel(percent);
						return (
							<div className="subscription-window" key={`${window.label}-${window.windowSeconds}`}>
								<div className="subscription-window-label">
									<span>{window.label}</span>
								</div>
								<div className="subscription-progress-row">
									<div
										className={`subscription-progress ${level}`}
										role="progressbar"
										aria-label={`${window.label}: ${percent}% used`}
										aria-valuetext={`${percent}% used`}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={percent}
									>
										<span style={{ width: `${percent}%` }} />
									</div>
									<strong className={`subscription-percent ${level}`} aria-hidden="true">
										{percent}% used
									</strong>
								</div>
								<div className="subscription-reset">{formatResetCountdown(window.resetsAt, now)}</div>
							</div>
						);
					})}
					{totalCredits ? (
						<div className="subscription-credits subscription-credit">
							<span>Total credits</span>
							<strong>{formatCredit(totalCredits)}</strong>
						</div>
					) : (
						openProvider.credits &&
						openProvider.credits.length > 0 && (
							<div className="subscription-credits">
								<h3>Credits</h3>
								{openProvider.credits.map((credit) => (
									<div className="subscription-credit" key={`${credit.label}-${credit.unit}`}>
										<span>{credit.label}</span>
										<strong>{formatCredit(credit)}</strong>
									</div>
								))}
							</div>
						)
					)}
					{openProvider.error && <p className="subscription-message">{openProvider.error}</p>}
					{!providerHasUsage(openProvider) && openProvider.state === "ok" && (
						<p className="subscription-message">No usage details are available yet.</p>
					)}
					<p className="subscription-freshness">
						{formatFreshness(openProvider.fetchedAt, openProvider.checkedAt, now)}
					</p>
				</section>
			)}
			<footer className="subscription-footer" aria-label="Subscription usage">
				<div className="subscription-footer-label">Subscriptions</div>
				{providers.length > 0 ? (
					<div className="subscription-provider-buttons" role="group" aria-label="Subscription providers">
						{providers.map((provider) => {
							const isOpen = provider.providerId === openProviderId;
							return (
								<button
									type="button"
									key={provider.providerId}
									ref={(element) => {
										if (element) buttonRefs.current.set(provider.providerId, element);
										else buttonRefs.current.delete(provider.providerId);
									}}
									className={`subscription-provider-button${isOpen ? " active" : ""}`}
									data-state={provider.state}
									aria-expanded={isOpen}
									aria-controls={`subscription-popover-${provider.providerId}`}
									title={provider.displayName}
									aria-label={provider.displayName}
									aria-describedby={
										provider.state === "unavailable"
											? `subscription-provider-unavailable-${provider.providerId}`
											: undefined
									}
									onClick={() => setOpenProviderId(isOpen ? null : provider.providerId)}
								>
									<ProviderBrandIcon providerId={provider.providerId} className="subscription-provider-icon" />
									{provider.state === "unavailable" && (
										<span
											id={`subscription-provider-unavailable-${provider.providerId}`}
											className="subscription-button-state"
											role="img"
											aria-label="Unavailable"
										>
											<FiAlertCircle aria-hidden="true" />
										</span>
									)}
								</button>
							);
						})}
					</div>
				) : (
					<div className="subscription-footer-message" aria-live="polite">
						{loading
							? "Checking subscriptions…"
							: status === "disabled"
								? "Subscriptions are unavailable until ready."
								: status === "unavailable"
									? "Subscription data unavailable."
									: "No configured subscriptions."}
					</div>
				)}
				{providers.length > 0 && status === "unavailable" && (
					<span className="subscription-footer-state">Some subscription data unavailable</span>
				)}
				{refreshing && (
					<span className="subscription-footer-state" aria-live="polite">
						Refreshing…
					</span>
				)}
				{requestError && !refreshing && <span className="subscription-footer-state">Refresh failed</span>}
			</footer>
		</div>
	);
}
