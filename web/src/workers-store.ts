/**
 * Module-level mirror of the ACTIVE conversation's delegated workers
 * (UiState.workers) for the delegate tool cards. Same shape as
 * app-globals.ts (cached value + listeners + useSyncExternalStore), kept
 * separate on purpose: workers change on every progress tick, and only the
 * few delegate cards subscribe — nothing else in the memoized message tree
 * re-renders. Written from one place (use-chat's snapshot effect).
 */
import { useSyncExternalStore } from "react";
import type { UiWorker } from "./types";

let cached: UiWorker[] = [];
let cachedSig = "";
const listeners = new Set<() => void>();

/** Cheap change signature: the server rebuilds the array every snapshot, so
 *  identity is useless; compare the fields a card renders instead. */
function signature(workers: readonly UiWorker[]): string {
	return workers
		.map(
			(w) =>
				`${w.id}|${w.toolCallId ?? ""}|${w.status}|${w.activity}|${w.ended ?? ""}|${w.text.length}|${w.recent.length}`,
		)
		.join(";");
}

export function setWorkers(workers: readonly UiWorker[] | undefined): void {
	const next = workers ?? [];
	const sig = signature(next);
	if (sig === cachedSig) return;
	cachedSig = sig;
	cached = [...next];
	for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

const get = () => cached;

/** Active conversation's workers; re-renders only when a rendered field changes. */
export function useWorkers(): UiWorker[] {
	return useSyncExternalStore(subscribe, get, get);
}

/** Live state of ONE delegate call's workers: "running" while any of them
 *  is still attached, "done" once every one finished, "unknown" when the
 *  store has no worker for that call (nothing reported yet, or an old
 *  session whose roster only lives in the tool result). The snapshot is a
 *  primitive, so a card re-renders only when its own state flips — the
 *  hundreds of non-delegate tool cards subscribing with null never do. */
export function useDelegateLiveState(toolCallId: string | null): "running" | "done" | "unknown" {
	return useSyncExternalStore(
		subscribe,
		() => delegateLiveState(cached, toolCallId),
		() => delegateLiveState(cached, toolCallId),
	);
}

export function delegateLiveState(
	workers: readonly UiWorker[],
	toolCallId: string | null,
): "running" | "done" | "unknown" {
	if (!toolCallId) return "unknown";
	let seen = false;
	for (const w of workers) {
		if (w.toolCallId !== toolCallId) continue;
		if (w.status === "starting" || w.status === "running") return "running";
		seen = true;
	}
	return seen ? "done" : "unknown";
}

/** Test hook: back to empty without notifying. */
export function resetWorkers(): void {
	cached = [];
	cachedSig = "";
}
