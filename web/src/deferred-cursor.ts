/**
 * Defer placing a textarea caret until after React has committed its value.
 *
 * The value check is intentional: a user edit can happen before the animation
 * frame runs, in which case the old navigation request must not move the caret
 * in the new draft.
 */
export function scheduleDeferredCursor(
	textarea: HTMLTextAreaElement | null,
	expectedValue: string,
	position = expectedValue.length,
): () => void {
	if (!textarea) return () => {};

	let cancelled = false;
	const frame = requestAnimationFrame(() => {
		if (cancelled || textarea.value !== expectedValue) return;
		textarea.selectionStart = textarea.selectionEnd = position;
	});

	return () => {
		cancelled = true;
		cancelAnimationFrame(frame);
	};
}
