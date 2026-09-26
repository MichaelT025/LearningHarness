/** Pure classification of an onScroll event — no DOM, no refs. The onScroll
 *  handler in MessageList applies the returned actions. Semantics preserved
 *  verbatim from 5cd680b:
 *   - graceActive (programmatic snap window): do nothing — our own jumps must
 *     never be read as upward user intent.
 *   - Large negative jump (dSt <= -500): layout collapse clamp, not a gesture —
 *     no escape.
 *   - Moderate negative jump (-500 < dSt < -4):
 *       · dSh < 0  → layout shift above viewport, NOT user intent; keep the
 *         stick and re-assert the snap (only when currently stuck && !escaped).
 *       · dSh >= 0 → true user wheel-up (content height unchanged) → escape.
 *   - Otherwise (dSt >= -4): no-op from this classifier.
 *  NOTE: while graceActive the handler deliberately does NOT re-assert, so
 *  reassert stays false there — behavior identical to pre-refactor. */
export function classifyScroll(args: {
	dSt: number;
	dSh: number;
	escaped: boolean;
	graceActive: boolean;
	stuck: boolean;
}): { flipEscape: boolean; reassert: boolean } {
	const { dSt, dSh, escaped, graceActive, stuck } = args;
	if (graceActive) return { flipEscape: false, reassert: false };
	if (dSt >= -4 || dSt <= -500) return { flipEscape: false, reassert: false };
	if (dSh < 0) {
		// Layout shift, NOT user intent: keep the stick and re-assert the snap —
		// the bottom moved up, follow it.
		return { flipEscape: false, reassert: stuck && !escaped };
	}
	// True user wheel-up: scrollHeight unchanged → escape.
	return { flipEscape: true, reassert: false };
}
