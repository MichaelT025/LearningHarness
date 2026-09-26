import type { CSSProperties } from "react";

/** Period of the `toolcall-shimmer` keyframes (messages.css / workers.css). */
export const SHIMMER_PERIOD_MS = 1800;

/**
 * Per-element phase for a shimmer label. Every running tool, thinking block
 * and worker uses the same 1.8 s sweep, and CSS animations that start in
 * the same frame run in lockstep — a delegate call fanning out three
 * workers, or a tool batch, then pulses as one block. A negative
 * `animation-delay` derived from a stable key (tool call id, worker id)
 * starts each sweep somewhere else in its cycle, and stays put across
 * re-renders because the key does not change.
 */
export function shimmerPhase(key: string | number): CSSProperties {
	const s = String(key);
	// FNV-1a — cheap and well spread for short ids.
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const offset = (h >>> 0) % SHIMMER_PERIOD_MS;
	return { animationDelay: `-${offset}ms` };
}
