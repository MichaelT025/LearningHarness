import { useEffect, useMemo, useRef, useState } from "react";
import { FiCheck, FiChevronDown, FiChevronRight, FiLoader } from "react-icons/fi";
import { useT } from "../i18n";
import type { TodoTask, TodosState } from "../types";

/**
 * Read-only views of the pi-todo task list (bridged as structured data by
 * server/todo-state.ts). The run view belongs immediately above the composer;
 * the session view is shared by every workspace tab.
 */

const LS_STRIP_COLLAPSED = "dispatch.todoStrip.collapsed";
const LS_SESSION_COLLAPSED = "dispatch.todoSession.collapsed";

function readStripPreference(): boolean {
	try {
		return localStorage.getItem(LS_STRIP_COLLAPSED) === "1";
	} catch {
		return false;
	}
}

function writeStripPreference(collapsed: boolean): void {
	try {
		localStorage.setItem(LS_STRIP_COLLAPSED, collapsed ? "1" : "0");
	} catch {
		/* private mode */
	}
}

function visibleTasks(tasks: TodoTask[]): TodoTask[] {
	return tasks.filter((task) => task.status !== "deleted");
}

function StatusGlyph({ status }: { status: TodoTask["status"] }) {
	if (status === "completed") return <FiCheck className="todo-glyph" aria-hidden />;
	if (status === "in_progress") return <FiLoader className="todo-glyph todo-glyph-spin" aria-hidden />;
	return <span className="todo-glyph todo-glyph-pending" aria-hidden />;
}

function TaskRow({
	task,
	byId,
	showIds,
	expandable = false,
	compact = false,
}: {
	task: TodoTask;
	byId: Map<number, TodoTask>;
	showIds: boolean;
	expandable?: boolean;
	compact?: boolean;
}) {
	const t = useT();
	const [descriptionOpen, setDescriptionOpen] = useState(false);
	// Only unresolved blockers matter; a completed blocker no longer blocks.
	const blockers = (task.blockedBy ?? []).filter((id) => byId.get(id)?.status !== "completed");
	const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
	const hasDescription = Boolean(task.description?.trim());
	const row = (
		<>
			{expandable && hasDescription && (
				<span className="todo-description-affordance" aria-hidden>
					{descriptionOpen ? <FiChevronDown /> : <FiChevronRight />}
				</span>
			)}
			<StatusGlyph status={task.status} />
			<span className="todo-subject">
				{showIds && <span className="todo-id">#{task.id}</span>}
				{label}
			</span>
			{!compact && task.owner && <span className="todo-owner">{task.owner}</span>}
			{!compact && blockers.length > 0 && task.status !== "completed" && (
				<span className="todo-blocked" title={t("todoBlockedBy", { ids: blockers.map((id) => `#${id}`).join(", ") })}>
					{t("todoBlocked")}: {blockers.map((id) => `#${id}`).join(", ")}
				</span>
			)}
		</>
	);

	if (!expandable || !hasDescription) {
		return (
			<li className={`todo-row${compact ? " todo-row-compact" : ""}`} data-status={task.status}>
				{row}
			</li>
		);
	}
	const descriptionId = `todo-description-${task.id}`;
	return (
		<li className={`todo-task${descriptionOpen ? " expanded" : ""}`} data-status={task.status}>
			<button
				type="button"
				className={`todo-row todo-row-button${compact ? " todo-row-compact" : ""}`}
				data-status={task.status}
				aria-expanded={descriptionOpen}
				aria-controls={descriptionId}
				onClick={() => setDescriptionOpen((open) => !open)}
			>
				{row}
			</button>
			{descriptionOpen && (
				<div id={descriptionId} className="todo-description">
					{task.description}
				</div>
			)}
		</li>
	);
}

function counts(tasks: TodoTask[]): { done: number; total: number } {
	let done = 0;
	for (const task of tasks) if (task.status === "completed") done++;
	return { done, total: tasks.length };
}

export function TodoStrip({ todos, onViewAll }: { todos: TodosState; onViewAll?: () => void }) {
	const t = useT();
	// An idle/last-run strip is always restored as a compact summary. The stored
	// value is the user's running preference, not the automatic end-of-run state.
	const [collapsed, setCollapsed] = useState<boolean>(() => (todos.running ? readStripPreference() : true));
	const previousRunning = useRef(todos.running);
	useEffect(() => {
		const wasRunning = previousRunning.current;
		if (!wasRunning && todos.running) setCollapsed(readStripPreference());
		if (wasRunning && !todos.running) setCollapsed(true);
		previousRunning.current = todos.running;
	}, [todos.running]);
	const toggleCollapsed = () => {
		setCollapsed((open) => {
			const next = !open;
			// Only explicit interaction changes the preference. Automatic collapse
			// at run end must not erase how the user prefers live runs displayed.
			writeStripPreference(next);
			return next;
		});
	};

	const byId = useMemo(() => new Map(todos.tasks.map((task) => [task.id, task])), [todos.tasks]);
	const runSet = useMemo(() => new Set(todos.runIds), [todos.runIds]);
	const tasks = useMemo(() => visibleTasks(todos.tasks).filter((task) => runSet.has(task.id)), [todos.tasks, runSet]);
	if (tasks.length === 0) return null;
	const { done, total } = counts(tasks);
	const active = tasks.find((task) => task.status === "in_progress");
	const title = todos.running ? t("todoRunTasks") : t("todoLastRun");

	return (
		<section className={`todo-strip${collapsed ? " collapsed" : ""}`} aria-label={title}>
			<div className="todo-strip-head-row">
				<button
					type="button"
					className="todo-strip-head"
					aria-expanded={!collapsed}
					aria-controls="todo-run-body"
					onClick={toggleCollapsed}
				>
					{collapsed ? <FiChevronRight aria-hidden /> : <FiChevronDown aria-hidden />}
					<span className="todo-strip-title">{title}</span>
					<span className="todo-count">
						{done}/{total}
					</span>
					{active && <span className="todo-strip-active">{active.activeForm || active.subject}</span>}
					{todos.running && <FiLoader className="todo-glyph todo-glyph-spin todo-strip-live" aria-hidden />}
				</button>
				{onViewAll && (
					<button type="button" className="todo-view-all" onClick={onViewAll}>
						{t("todoViewAll")}
					</button>
				)}
			</div>
			{!collapsed && (
				<ul id="todo-run-body" className="todo-list todo-strip-list">
					{tasks.map((task) => (
						<TaskRow key={task.id} task={task} byId={byId} showIds={false} compact />
					))}
				</ul>
			)}
		</section>
	);
}

export function TodoPanel({ todos, focusRequest }: { todos: TodosState; focusRequest?: number }) {
	const t = useT();
	const panelHeadRef = useRef<HTMLButtonElement>(null);
	const [collapsed, setCollapsed] = useState<boolean>(() => {
		try {
			return localStorage.getItem(LS_SESSION_COLLAPSED) === "1";
		} catch {
			return false;
		}
	});
	const [completedOpen, setCompletedOpen] = useState(false);
	useEffect(() => {
		try {
			localStorage.setItem(LS_SESSION_COLLAPSED, collapsed ? "1" : "0");
		} catch {
			/* private mode */
		}
	}, [collapsed]);
	useEffect(() => {
		if (focusRequest === undefined || focusRequest <= 0) return;
		setCollapsed(false);
		const frame = requestAnimationFrame(() => panelHeadRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [focusRequest]);

	const byId = useMemo(() => new Map(todos.tasks.map((task) => [task.id, task])), [todos.tasks]);
	const tasks = useMemo(() => visibleTasks(todos.tasks), [todos.tasks]);
	if (tasks.length === 0) return null;
	const active = tasks.filter((task) => task.status === "in_progress");
	const pending = tasks.filter((task) => task.status === "pending");
	const completed = tasks.filter((task) => task.status === "completed");
	const orderedOpen = [...active, ...pending];
	const { done, total } = counts(tasks);

	return (
		<section className={`todo-panel${collapsed ? " collapsed" : ""}`} aria-label={t("todoSessionTasks")}>
			<button
				ref={panelHeadRef}
				type="button"
				className="todo-panel-head"
				aria-expanded={!collapsed}
				aria-controls="todo-session-body"
				onClick={() => setCollapsed((open) => !open)}
			>
				{collapsed ? <FiChevronRight aria-hidden /> : <FiChevronDown aria-hidden />}
				<span className="todo-panel-title">{t("todoSessionTasks")}</span>
				<span className="todo-count">
					{done}/{total}
				</span>
			</button>
			{!collapsed && (
				<div id="todo-session-body" className="todo-session-body">
					{orderedOpen.length > 0 && (
						<ul className="todo-list todo-session-list">
							{orderedOpen.map((task) => (
								<TaskRow key={task.id} task={task} byId={byId} showIds expandable />
							))}
						</ul>
					)}
					{completed.length > 0 && (
						<div className="todo-completed-group">
							<button
								type="button"
								className="todo-completed-head"
								aria-expanded={completedOpen}
								aria-controls="todo-completed-body"
								onClick={() => setCompletedOpen((open) => !open)}
							>
								{completedOpen ? <FiChevronDown aria-hidden /> : <FiChevronRight aria-hidden />}
								<span>{t("todoCompleted")}</span>
								<span className="todo-count">{completed.length}</span>
							</button>
							{completedOpen && (
								<ul id="todo-completed-body" className="todo-list todo-session-list todo-completed-list">
									{completed.map((task) => (
										<TaskRow key={task.id} task={task} byId={byId} showIds expandable />
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			)}
		</section>
	);
}
