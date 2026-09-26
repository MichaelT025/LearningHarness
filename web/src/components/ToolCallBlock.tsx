import { memo, useEffect, useMemo, useState, type ComponentType } from "react";
import {
	FiArrowRight,
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiCompass,
	FiCopy,
	FiEdit3,
	FiFilePlus,
	FiFileText,
	FiFolder,
	FiGlobe,
	FiSearch,
	FiSquare,
	FiTerminal,
	FiTool,
	FiUsers,
	FiX,
} from "react-icons/fi";
import type { ToolStatus, UiMessage, UiToolCallBlock, UiWorker } from "../types";
import { useT } from "../i18n";
import { parseDelegateTasks, toolArgHints } from "../tool-args";
import { toolSummary } from "../tool-summary";
import {
	formatElapsed,
	isWorkerActive,
	workerElapsedSec,
	workersForCall,
	workerStatusLabel,
	workerStatusTone,
} from "../workers";
import { useDelegateLiveState, useWorkers } from "../workers-store";
import { RoleChip } from "./RoleChip";
import { shimmerPhase } from "../shimmer";

/** Window event the delegate card fires to open one worker in the Workers
 *  pane (App.tsx listens; the card sits deep in the memoized message tree).
 *  detail = worker id, or null for the pane's list. */
export const OPEN_WORKER_EVENT = "pi-web-ui:open-worker";

export interface ToolView {
	/** Tool result message if the tool already finished. */
	result?: UiMessage;
	/** Live output accumulated from tool_delta while running. */
	liveOutput?: string;
	/** True when the session is streaming (tool may still be running). */
	streaming: boolean;
	/** Set the moment tool_execution_end fires (tool_status) — the command
	 *  exited but the model hasn't responded yet. */
	status?: ToolStatus;
}

/** Kill just the running bash command(s) — the agent run itself continues. */
export type KillBashHandler = () => void;

const TOOL_ICONS: Record<string, ComponentType> = {
	bash: FiTerminal,
	delegate: FiUsers,
	read: FiFileText,
	write: FiFilePlus,
	edit: FiEdit3,
	edit_soft: FiEdit3,
	grep: FiSearch,
	find: FiCompass,
	glob: FiCompass,
	ls: FiFolder,
	web_fetch: FiGlobe,
	fetch: FiGlobe,
	web_search: FiGlobe,
};

export function ToolIcon({ name }: { name: string }) {
	const Icon = TOOL_ICONS[name] ?? FiTool;
	return <Icon />;
}

export const ToolCallBlock = memo(function ToolCallBlock({
	block,
	view,
	onKillBash,
	wrap = true,
	forceOpen = false,
}: {
	block: UiToolCallBlock;
	view: ToolView;
	/** Kill the running bash command (bash cards only, while running). */
	onKillBash?: KillBashHandler;
	/** 设置面板「完整显示工具」开关：true（开）→ 工具始终完整展开；
	 *  false（关）→ 默认折叠，点击展开。 */
	wrap?: boolean;
	/** 会话内搜索打开时强制展开（折叠内容不在 DOM，搜索索引搜到的词会
	 *  “展开后看不到”——见 ThinkingBlock.forceOpen）。 */
	forceOpen?: boolean;
}) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 全部展开；wrap=false（关）→ 全部折叠。
	// 与 ThinkingBlock 一致——开关切换时自动折叠/展开所有未手动点过的工具。
	const [open, setOpen] = useState<boolean | null>(null);
	const isError = view.result?.isError ?? view.status?.isError ?? false;
	// 错误卡也默认折叠——标题行的 ✕ 徽标已标出失败，点击即可看输出。
	const expanded = open ?? wrap;
	// 搜索期间 forceOpen 只是“视口展开”，用户 open 状态不受影响
	const shown = expanded || forceOpen;
	const [copied, setCopied] = useState(false);

	// PiAstra delegate returns as soon as its workers START (async
	// delegation); the card stays "running" until the last worker lands.
	const isDelegate = block.name === "delegate";
	const workersRunning = useDelegateLiveState(isDelegate ? block.id : null) === "running";
	const running = (!view.result && view.streaming && !view.status) || workersRunning;
	const isBashRunning = block.name === "bash" && running;
	const done = view.result !== undefined && !workersRunning;
	/** Command finished (tool_status fired) but the authoritative toolResult
	 *  message hasn't landed in a snapshot yet — the model is still chewing on
	 *  the result. */
	const waitingModel = !view.result && !!view.status;

	const rawOutput = view.result
		? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
		: (view.liveOutput ?? "");
	const output = rawOutput.replace(/…\[LIVE_OMIT:(\d+)\]…\n/, (_, n) => t("liveOutputOmitted", { n }));
	// PiAstra delegate: the card body is the live worker roster (workers-store),
	// not the raw arguments; the result text is a status dump, so hide it
	// unless the call itself failed.

	const statusClass = isError ? "err" : done ? "ok" : running || waitingModel ? "run" : "idle";
	let statusLabel = isError
		? t("error")
		: done
			? t("done")
			: running
				? t("running")
				: waitingModel
					? t("toolDoneWaitingModel")
					: t("toolQueued");
	const duration = waitingModel && view.status?.durationMs !== undefined ? formatDuration(view.status.durationMs) : "";
	if (waitingModel && duration) statusLabel = `${statusLabel} · ${duration}`;

	// tool_status doesn't carry the exit code for successful bash runs (only
	// failures embed "exited with code N" in the error text); show it when known.
	const exitHint = waitingModel && view.status?.exitCode !== undefined ? `exit ${view.status.exitCode}` : "";

	// 卡头右侧提示：任何工具都从参数里安全取路径/超时（AI 填错也只是不显示，见
	// tool-args.ts）；bash 类的命令行给正文的终端行，折叠时卡头跟一小段预览。
	// delegate_task 额外取 agent 名。
	const hints = toolArgHints(block.argumentsText);
	const bashCommand = block.name === "bash" ? hints.command : undefined;
	// 折叠摘要：「Reading src/app.ts」「Running git status」——运行中用现在时并
	// 加流光，结束后改过去时。展开态也用同一行做标题，正文再给原始参数。
	const summary = toolSummary(block.name, hints, running || waitingModel ? "running" : "done");
	const summaryTitle = summary.title ?? summary.target;

	const copyArgs = () => {
		if (block.argumentsText) {
			void navigator.clipboard.writeText(block.argumentsText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}
	};

	return (
		<div className={`toolcall ${statusClass}${shown ? " expanded" : " collapsed"}`}>
			<div
				className="chead toolcall-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={shown ? t("collapseMsg") : t("expandMsg")}
				onClick={() => setOpen(!expanded)}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(!expanded);
					}
				}}
			>
				<button
					type="button"
					className="chead-toggle toolcall-toggle"
					title={shown ? t("collapseMsg") : t("expandMsg")}
					aria-label={shown ? t("collapseMsg") : t("expandMsg")}
					aria-expanded={shown}
					onClick={(e) => {
						e.stopPropagation();
						setOpen(!expanded);
					}}
				>
					{shown ? <FiChevronDown /> : <FiChevronRight />}
				</button>
				<span className="chead-icon toolcall-icon">
					<ToolIcon name={block.name} />
				</span>
				<span
					className={`toolcall-summary${running ? " shimmer" : ""}`}
					style={running ? shimmerPhase(block.id) : undefined}
					title={summaryTitle ? `${block.name} · ${summaryTitle}` : block.name}
					aria-label={`${statusLabel}: ${summary.verb} ${summary.target ?? ""}`.trim()}
				>
					<span className="toolcall-verb">{summary.verb}</span>
					{summary.target && <span className={`toolcall-target${summary.mono ? " mono" : ""}`}>{summary.target}</span>}
				</span>
				{isError && (
					<span className="toolcall-status" title={statusLabel} aria-hidden="true">
						<FiX />
					</span>
				)}
				{waitingModel && duration && <span className="toolcall-timeout">{duration}</span>}
				{exitHint && <span className="toolcall-timeout">{exitHint}</span>}
				{hints.timeout && shown && <span className="toolcall-timeout">⏱ {hints.timeout}</span>}
				<span className="toolcall-spacer" />
				{shown && isBashRunning && onKillBash && (
					<button
						type="button"
						className="toolcall-kill"
						title={t("stopBashTip")}
						onClick={(e) => {
							e.stopPropagation();
							onKillBash?.();
						}}
					>
						<FiSquare />
						<span>{t("stopBash")}</span>
					</button>
				)}
				{isDelegate && (
					<button
						type="button"
						className="toolcall-open"
						title={t("workersOpenPane")}
						onClick={(e) => {
							e.stopPropagation();
							window.dispatchEvent(new CustomEvent<number | null>(OPEN_WORKER_EVENT, { detail: null }));
						}}
					>
						<FiArrowRight />
						<span>{t("workersOpenPane")}</span>
					</button>
				)}
				{shown && (
					<button
						type="button"
						className="chead-copy toolcall-copy"
						title={t("copyArgs")}
						onClick={(e) => {
							e.stopPropagation();
							copyArgs();
						}}
					>
						{copied ? <FiCheckCircle /> : <FiCopy />}
					</button>
				)}
			</div>
			{shown && (
				<div className="toolcall-body">
					<div className="toolcall-raw-name">
						<code>{block.name}</code>
					</div>
					{isDelegate ? (
						<DelegateWorkers toolCallId={block.id} argumentsText={block.argumentsText} result={view.result} />
					) : (
						block.argumentsText && (
							<div className="toolcall-args">
								{bashCommand ? <TerminalCommand command={bashCommand} /> : <pre>{block.argumentsText}</pre>}
							</div>
						)
					)}
					{(!isDelegate || isError) && output.length > 0 && (
						<div className="toolcall-output">
							<div className="toolcall-output-label">
								{isError ? t("errorOutput") : t("output")}
								{(running || waitingModel) && <span className="cursor" />}
							</div>
							<pre>{output}</pre>
						</div>
					)}
					{!isDelegate && running && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> {t("waitingOutput")}
						</div>
					)}
					{waitingModel && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> {t("waitingModel")}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

/** Pretty-print a bash tool call's command line as a terminal row. */
function TerminalCommand({ command }: { command: string }) {
	return (
		<div className="termline">
			<FiTerminal className="termline-icon" />
			<code>{command}</code>
		</div>
	);
}

/**
 * Delegate card body: one row per worker of THIS call (live from the workers
 * store, or the roster saved in the result for old sessions), each opening
 * that worker's transcript in the Workers pane. Before the extension has
 * reported anything, the tasks the orchestrator wrote stand in.
 */
function DelegateWorkers({
	toolCallId,
	argumentsText,
	result,
}: {
	toolCallId: string;
	argumentsText?: string;
	result?: UiMessage;
}) {
	const t = useT();
	const all = useWorkers();
	const workers = useMemo(() => workersForCall(all, toolCallId, result), [all, toolCallId, result]);
	const tasks = useMemo(
		() => (workers.length === 0 ? parseDelegateTasks(argumentsText) : []),
		[workers.length, argumentsText],
	);
	const anyActive = workers.some((w) => isWorkerActive(w.status));
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!anyActive) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [anyActive]);
	if (workers.length === 0) {
		if (tasks.length === 0) return null;
		return (
			<div className="delegate-workers">
				{tasks.map((task, i) => (
					<div className="delegate-worker pending" data-role={task.role} key={i}>
						<div className="delegate-worker-head">
							<RoleChip role={task.role} />
							{task.access && <span className="delegate-worker-access">{task.access}</span>}
							<span className="worker-status">{t("workersPending")}</span>
						</div>
						<div className="delegate-worker-task">{task.task}</div>
					</div>
				))}
			</div>
		);
	}
	return (
		<div className="delegate-workers">
			{workers.map((w) => (
				<DelegateWorkerRow key={w.id} worker={w} now={now} />
			))}
		</div>
	);
}

function DelegateWorkerRow({ worker, now }: { worker: UiWorker; now: number }) {
	const t = useT();
	const running = isWorkerActive(worker.status);
	const open = () => window.dispatchEvent(new CustomEvent<number | null>(OPEN_WORKER_EVENT, { detail: worker.id }));
	return (
		<div
			className={`delegate-worker tone-${workerStatusTone(worker.status)}`}
			data-role={worker.role}
			role="button"
			tabIndex={0}
			title={t("workersOpenOne")}
			onClick={open}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			}}
		>
			<div className="delegate-worker-head">
				<RoleChip role={worker.role} />
				<span className="worker-id">#{worker.id}</span>
				<span
					className={`worker-status${running ? " shimmer" : ""}`}
					style={running ? shimmerPhase(worker.id) : undefined}
				>
					{workerStatusLabel(worker.status)}
				</span>
				<span className="worker-elapsed">{formatElapsed(workerElapsedSec(worker, now))}</span>
				<span className="worker-spacer" />
				<FiArrowRight className="delegate-worker-go" aria-hidden="true" />
			</div>
			<div className="delegate-worker-task" title={worker.task}>
				{worker.task}
			</div>
			<div className="delegate-worker-activity">{worker.activity}</div>
		</div>
	);
}

/** "0.3s" / "12.0s" / "1m 05s" — for the tool_status duration hint. */
function formatDuration(ms?: number): string {
	if (ms === undefined) return "";
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}
