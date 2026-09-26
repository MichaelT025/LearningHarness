/**
 * todo-state.ts — Structured todo list bridged from the pi-todo extension.
 *
 * The CLI's `todo` tool returns a full `{ tasks, nextId }` snapshot in every
 * tool result's `details`, and reconstructs its state by replaying the latest
 * such result on the branch (extensions/pi-todo/state/replay.ts). We do the
 * same here so the browser gets real task objects instead of the TUI widget's
 * pre-rendered text lines. Per conversation: the task list is per session
 * branch, and "current run" ids are the tasks the agent created or changed
 * since the last agent_start (feeds the strip above the composer).
 */

import type { TodoTask, TodosState } from "./protocol.js";

/** Tool name pinned by pi-todo (`tool/types.ts`: TOOL_NAME). */
export const TODO_TOOL_NAME = "todo";
/** Widget key pinned by pi-todo (`todo-overlay.ts`: WIDGET_KEY). The text
 *  widget is suppressed because the structured view replaces it. */
export const TODO_WIDGET_KEY = "rpiv-todos";

interface TaskDetails {
	tasks: TodoTask[];
	nextId: number;
	error?: string;
}

/** Mirrors pi-todo's `isTaskDetails` discriminator. */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

export class ConversationTodos {
	private tasks: TodoTask[] = [];
	private nextId = 1;
	private runIds = new Set<number>();
	private running = false;

	/** Last-write-wins replay of the branch's `todo` tool results.
	 *
	 * `agent_start` is an event, not a persisted branch message, so historical
	 * replay uses user messages as an approximate run boundary. This can split
	 * or join a run incorrectly when steering happens inside one agent run;
	 * live startRun/endRun tracking is authoritative while a runtime is live.
	 * Keep live membership on a rebind rather than replacing it with a stale
	 * persisted snapshot. */
	replay(branch: Iterable<unknown>): void {
		const restored = new ConversationTodos();
		for (const entry of branch) {
			const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
			if (e.type !== "message") continue;
			const msg = e.message;
			// Historical sessions have user messages, not agent_start events.
			// Use the latest prompt as the restoration boundary; live runs use startRun.
			if (msg?.role === "user") restored.runIds.clear();
			if (msg?.role !== "toolResult" || msg.toolName !== TODO_TOOL_NAME) continue;
			restored.apply(msg.details);
		}
		this.tasks = restored.tasks;
		this.nextId = restored.nextId;
		if (!this.running) {
			this.runIds = new Set(restored.runIds);
		} else {
			// A rebind keeps the live set, but not tombstones or ids absent from
			// the newly restored full snapshot.
			const visibleIds = new Set(this.tasks.filter((task) => task.status !== "deleted").map((task) => task.id));
			this.runIds = new Set([...this.runIds].filter((id) => visibleIds.has(id)));
		}
	}

	/** A run began: the strip starts empty and fills as the agent touches tasks. */
	startRun(): void {
		this.runIds.clear();
		this.running = true;
	}

	/** Finish without clearing membership; the strip shows the last run until startRun. */
	endRun(): void {
		this.running = false;
	}

	/** Apply a snapshot; only mutations contribute run membership, never reads. */
	apply(details: unknown): boolean {
		if (!isTaskDetails(details)) return false;
		const operation = details as TaskDetails & { action?: string; params?: { id?: number } };
		const readOnly = ["list", "get"].includes(operation.action ?? "");
		if (operation.action === "clear") this.runIds.clear();
		const prev = new Map(this.tasks.map((t) => [t.id, t]));
		const next = details.tasks.map((t) => ({ ...t }));
		for (const t of next) {
			const p = prev.get(t.id);
			const changed = !p || JSON.stringify(p) !== JSON.stringify(t);
			const explicitlyUpdated =
				operation.error === undefined && operation.action === "update" && operation.params?.id === t.id;
			if (!readOnly && (changed || explicitlyUpdated)) this.runIds.add(t.id);
		}
		const visibleIds = new Set(next.filter((task) => task.status !== "deleted").map((task) => task.id));
		this.runIds = new Set([...this.runIds].filter((id) => visibleIds.has(id)));
		this.tasks = next;
		this.nextId = details.nextId;
		return true;
	}

	snapshot(): TodosState {
		return {
			tasks: this.tasks.map((t) => ({ ...t })),
			nextId: this.nextId,
			runIds: [...this.runIds],
			running: this.running,
		};
	}
}

export const EMPTY_TODOS: TodosState = { tasks: [], nextId: 1, runIds: [], running: false };
