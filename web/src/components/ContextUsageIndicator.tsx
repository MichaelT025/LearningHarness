import type { UiState } from "../types";
import { useT } from "../i18n";

interface ContextUsageIndicatorProps {
	usage: UiState["stats"]["contextUsage"] | null | undefined;
}

const RADIUS = 7;

function finiteNonNegative(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatTokens(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

/** A small, non-interactive context budget indicator for the composer. */
export function ContextUsageIndicator({ usage }: ContextUsageIndicatorProps) {
	const t = useT();
	const tokens = finiteNonNegative(usage?.tokens);
	const contextWindow =
		typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
			? usage.contextWindow
			: null;
	const known = tokens !== null && contextWindow !== null;
	const percent = known ? Math.min(100, Math.max(0, (tokens / contextWindow) * 100)) : null;
	const label = known
		? usage?.estimated
			? t("contextUsageEstimated", {
					tokens: formatTokens(tokens!),
					capacity: formatTokens(contextWindow!),
					percent: formatPercent(percent!),
				})
			: t("contextUsageDetail", {
					tokens: formatTokens(tokens!),
					capacity: formatTokens(contextWindow!),
					percent: formatPercent(percent!),
				})
		: t("contextUsageUnavailable");
	return (
		<span
			className={`context-usage-indicator${known ? "" : " unknown"}${usage?.estimated && known ? " estimated" : ""}`}
			tabIndex={0}
			role="progressbar"
			aria-label={label}
			aria-valuemin={known ? 0 : undefined}
			aria-valuemax={known ? 100 : undefined}
			aria-valuenow={percent ?? undefined}
			aria-valuetext={known ? label : t("contextUsageUnavailable")}
		>
			<svg className="context-usage-ring" viewBox="0 0 18 18" aria-hidden="true">
				<circle className="context-usage-ring-track" cx="9" cy="9" r={RADIUS} />
				<circle
					className="context-usage-ring-progress"
					cx="9"
					cy="9"
					r={RADIUS}
					pathLength="100"
					strokeDasharray={percent === null ? "18 82" : "100"}
					strokeDashoffset={percent === null ? "0" : `${100 - percent}`}
				/>
			</svg>
			<span className="context-usage-tooltip" role="tooltip">
				{label}
			</span>
		</span>
	);
}
