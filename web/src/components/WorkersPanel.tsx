import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowLeft, FiCheck, FiClock, FiPause, FiPlay, FiSquare, FiUsers, FiX, FiAlertCircle } from "react-icons/fi";
import type { ClientMessage, ToolStatus, UiMessage, UiWorker, UiWorkerTranscript } from "../types";
import { useT } from "../i18n";
import {
	formatElapsed,
	isWorkerActive,
	splitWorkers,
	taskPreview,
	workerElapsedSec,
	workerStatusLabel,
	workerStatusTone,
} from "../workers";
import { Message } from "./Message";
import { RoleChip } from "./RoleChip";

/**
 * Right-workspace Workers pane: read-only Running / Finished / Failed lists of
 * the ACTIVE conversation's delegated workers, and one worker's transcript
 * rendered with the chat's own message components. Following a worker is a
 * server subscription (open_worker → worker_transcript pushes → close_worker).
 */
interface WorkersPanelProps {
	workers: UiWorker[];
	transcripts: ReadonlyMap<number, UiWorkerTranscript>;
	/** Active conversation id — a switch re-subscribes the selected worker. */
	conversationId: string | undefined;
	/** Selected worker (controlled: the delegate card can open one directly). */
	selected: number | null;
	onSelect: (id: number | null) => void;
	send: (msg: ClientMessage) => boolean;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
}

const EMPTY_LIVE: ReadonlyMap<string, { toolName: string; text: string }> = new Map();
const EMPTY_STATUS: ReadonlyMap<string, ToolStatus> = new Map();

/** Re-render once a second while any worker runs (elapsed counters). */
function useTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);
	return active ? now : Date.now();
}

export const WorkersPanel = memo(function WorkersPanel({
	workers,
	transcripts,
	conversationId,
	selected,
	onSelect,
	send,
	thinkingWrap,
	toolsWrap,
}: WorkersPanelProps) {
	const t = useT();
	const { active, done, failed } = useMemo(() => splitWorkers(workers), [workers]);
	const now = useTick(active.length > 0);
	const current = selected === null ? undefined : workers.find((w) => w.id === selected);

	// Follow the selected worker for as long as it is shown (and re-follow
	// after a conversation switch, which drops the client's transcripts).
	useEffect(() => {
		if (selected === null || !conversationId) return;
		send({ type: "open_worker", workerId: selected });
		return () => {
			send({ type: "close_worker", workerId: selected });
		};
	}, [selected, conversationId, send]);

	// The selected worker vanished (session restore / switch): back to the list.
	useEffect(() => {
		if (selected !== null && workers.length > 0 && !workers.some((w) => w.id === selected)) onSelect(null);
	}, [selected, workers, onSelect]);

	if (current) {
		return (
			<WorkerDetail
				worker={current}
				transcript={transcripts.get(current.id)}
				now={now}
				onBack={() => onSelect(null)}
				onCancel={() => send({ type: "cancel_worker", workerId: current.id })}
				thinkingWrap={thinkingWrap}
				toolsWrap={toolsWrap}
			/>
		);
	}

	if (workers.length === 0) {
		return (
			<div className="workers-empty">
				<FiUsers aria-hidden="true" />
				<div className="workers-empty-title">{t("workersEmptyTitle")}</div>
				<div className="workers-empty-sub">{t("workersEmptyHint")}</div>
			</div>
		);
	}

	return (
		<div className="workers-list">
			<WorkerSection
				id="workers-active"
				title={t("workersActive")}
				count={active.length}
				workers={active}
				now={now}
				onSelect={onSelect}
			/>
			<WorkerSection
				id="workers-done"
				title={t("workersDone")}
				count={done.length}
				workers={done}
				now={now}
				onSelect={onSelect}
				collapsible
				defaultOpen
			/>
			<WorkerSection
				id="workers-failed"
				title={t("workersFailed")}
				count={failed.length}
				workers={failed}
				now={now}
				onSelect={onSelect}
				collapsible
				defaultOpen
			/>
		</div>
	);
});

function WorkerSection({
	id,
	title,
	count,
	workers,
	now,
	onSelect,
	collapsible = false,
	defaultOpen = false,
}: {
	title: string;
	count: number;
	id: string;
	workers: UiWorker[];
	now: number;
	onSelect: (id: number) => void;
	collapsible?: boolean;
	defaultOpen?: boolean;
}) {
	const t = useT();
	const headingId = `${id}-heading`;
	const heading = (
		<>
			<span>{title}</span>
			<span className="workers-section-count">{count}</span>
		</>
	);
	const rows = (
		<>
			{workers.length === 0 && <div className="workers-section-empty">{t("workersNone")}</div>}
			{workers.length > 0 && (
				<ul className="workers-section-list" aria-labelledby={headingId}>
					{workers.map((w) => (
						<WorkerRow key={w.id} worker={w} now={now} onClick={() => onSelect(w.id)} />
					))}
				</ul>
			)}
		</>
	);
	if (collapsible) {
		return (
			<details className="workers-section" aria-labelledby={headingId} open={defaultOpen}>
				<summary className="workers-section-head" id={headingId}>
					{heading}
				</summary>
				{rows}
			</details>
		);
	}
	return (
		<section className="workers-section" aria-labelledby={headingId}>
			<div className="workers-section-head" id={headingId}>
				{heading}
			</div>
			{rows}
		</section>
	);
}

/** The first line/sentence is a conservative label; never invent a summary. */
function workerListTaskPreview(task: string): string {
	const firstLine = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return (firstLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? firstLine).replace(/\s+/g, " ").trim();
}

/** Second line of a row: what the worker is doing now, or what it came
 *  back with. Running → the extension's activity line; completed → the first
 *  line of its result; failed / cancelled / interrupted → the activity, which
 *  the extension sets to the reason. Never invented: empty when unknown. */
export function workerListDetail(worker: Pick<UiWorker, "status" | "activity" | "text">): string {
	const firstLine = (s: string) =>
		s
			.split(/\r?\n/)
			.find((l) => l.trim())
			?.replace(/\s+/g, " ")
			.trim() ?? "";
	if (worker.status === "completed") return firstLine(worker.text) || firstLine(worker.activity);
	return firstLine(worker.activity);
}

/** One worker: who (role glyph + role + id), what (task), how long, and
 *  underneath, what it is doing or what it returned. */
function WorkerRow({ worker, now, onClick }: { worker: UiWorker; now: number; onClick: () => void }) {
	const tone = workerStatusTone(worker.status);
	const running = isWorkerActive(worker.status);
	const status = workerStatusLabel(worker.status);
	const task = workerListTaskPreview(worker.task);
	const detail = workerListDetail(worker);
	const StatusIcon = {
		starting: FiClock,
		running: FiPlay,
		completed: FiCheck,
		failed: FiAlertCircle,
		cancelled: FiX,
		interrupted: FiPause,
	}[worker.status];
	return (
		<li className="worker-row-item">
			<button type="button" className={`worker-row tone-${tone}`} data-role={worker.role} onClick={onClick}>
				<span className={`worker-row-status worker-status tone-${tone}`} role="img" aria-label={status} title={status}>
					<StatusIcon className="worker-row-status-icon" aria-hidden="true" />
				</span>
				<RoleChip role={worker.role} />
				<span className="worker-id">#{worker.id}</span>
				<span className="worker-task" title={task}>
					{task}
				</span>
				<span className="worker-elapsed">{formatElapsed(workerElapsedSec(worker, now))}</span>
				{detail && (
					<span className={`worker-row-detail${running ? " live" : ""}`} title={detail}>
						{detail}
					</span>
				)}
			</button>
		</li>
	);
}

function WorkerDetail({
	worker,
	transcript,
	now,
	onBack,
	onCancel,
	thinkingWrap,
	toolsWrap,
}: {
	worker: UiWorker;
	transcript: UiWorkerTranscript | undefined;
	now: number;
	onBack: () => void;
	onCancel: () => void;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
}) {
	const t = useT();
	const running = isWorkerActive(worker.status);
	const tone = workerStatusTone(worker.status);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const messages = transcript?.messages ?? [];
	const streaming = transcript?.streamingMessage ?? null;
	const all = streaming ? [...messages, streaming] : messages;
	const toolResults = useMemo(() => {
		const m = new Map<string, UiMessage>();
		for (const msg of messages) if (msg.role === "toolResult" && msg.toolCallId) m.set(msg.toolCallId, msg);
		return m;
	}, [messages]);
	const lastId = all.length > 0 ? all[all.length - 1].id : null;

	// Follow live output unless the user scrolled up (same rule as the chat).
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) el.scrollTop = el.scrollHeight;
	}, [transcript]);
	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
	};

	return (
		<div className="worker-detail">
			<div className="worker-detail-head">
				<button
					type="button"
					className="worker-back"
					title={t("workersBack")}
					aria-label={t("workersBack")}
					onClick={onBack}
				>
					<FiArrowLeft />
				</button>
				<div className="worker-detail-meta">
					<RoleChip role={worker.role} />
					<span className="worker-id">#{worker.id}</span>
					<span className="worker-model" title={worker.model}>
						{worker.model}
					</span>
				</div>
				<span className={`worker-status worker-detail-status tone-${tone}`}>
					<span className="worker-status-dot" aria-hidden="true" />
					{workerStatusLabel(worker.status)}
				</span>
				<span className="worker-elapsed">{formatElapsed(workerElapsedSec(worker, now))}</span>
				{running && (
					<button type="button" className="worker-cancel" title={t("workersStopTip")} onClick={onCancel}>
						<FiSquare aria-hidden="true" />
						<span>{t("workersStop")}</span>
					</button>
				)}
			</div>
			<details className="worker-detail-task">
				<summary>
					<span className="worker-detail-label">{t("workersTask")}</span>
					<span className="worker-detail-task-preview">{taskPreview(worker.task)}</span>
				</summary>
				<div className="worker-detail-task-text">{worker.task}</div>
			</details>
			<div className="worker-transcript" ref={scrollRef} onScroll={onScroll}>
				{transcript === undefined && <div className="worker-transcript-note">{t("workersLoading")}</div>}
				{transcript !== undefined && all.length === 0 && (
					<div className="worker-transcript-note">
						{transcript.source === "none" ? t("workersNoTranscript") : t("workersWaiting")}
					</div>
				)}
				{all.map((m) => (
					<Message
						key={m.id}
						message={m}
						toolResults={toolResults}
						liveOutputs={EMPTY_LIVE}
						toolStatuses={EMPTY_STATUS}
						streaming={running}
						isLast={m.id === lastId}
						toolsWrap={toolsWrap}
						thinkingWrap={thinkingWrap}
					/>
				))}
			</div>
			<div className={`worker-detail-foot tone-${workerStatusTone(worker.status)}`} role="status">
				{worker.activity || workerStatusLabel(worker.status)}
			</div>
		</div>
	);
}
