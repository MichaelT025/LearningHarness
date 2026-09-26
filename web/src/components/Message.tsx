import { memo, useState } from "react";
import { shimmerPhase } from "../shimmer";
import {
	FiArchive,
	FiBookOpen,
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiChevronUp,
	FiCopy,
	FiEdit3,
	FiImage,
	FiX,
} from "react-icons/fi";
import type {
	PromptAttachment,
	ToolStatus,
	UiBashBlock,
	UiContentBlock,
	UiImageBlock,
	UiMessage,
	UiTextBlock,
	UiThinkingBlock,
	UiToolCallBlock,
} from "../types";
import { Markdown } from "./Markdown";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallBlock, type ToolView } from "./ToolCallBlock";
import { WORKER_RESULT_TYPE, WorkerResultCard, workerResultsFromDetails } from "./WorkerResultCard";
import { useT, type Translate } from "../i18n";
import { parseSkillBlock, type SkillBlock } from "../skill-block";
import { isRasterImage, fileToProcessedImage } from "../image-paste";

/** 编辑重问编辑器里直接拖入/粘贴文件的上限（与服务端 MAX_UPLOAD_BYTES 一致）。 */
const MAX_EDIT_UPLOAD_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Narrowing guards. UiContentBlock is an open union (its last member is
// `{ type: string; [k: string]: unknown }`), so plain `switch` narrowing does
// not work — same pattern pi-vsc uses in shared/blocks.ts.
// ---------------------------------------------------------------------------

export function asText(block: UiContentBlock): UiTextBlock | null {
	return block.type === "text" && typeof (block as UiTextBlock).text === "string" ? (block as UiTextBlock) : null;
}

export function asThinking(block: UiContentBlock): UiThinkingBlock | null {
	return block.type === "thinking" && typeof (block as UiThinkingBlock).thinking === "string"
		? (block as UiThinkingBlock)
		: null;
}

export function asToolCall(block: UiContentBlock): UiToolCallBlock | null {
	return block.type === "toolCall" &&
		typeof (block as UiToolCallBlock).id === "string" &&
		typeof (block as UiToolCallBlock).name === "string"
		? (block as UiToolCallBlock)
		: null;
}

export function asImage(block: UiContentBlock): UiImageBlock | null {
	return block.type === "image" && typeof (block as UiImageBlock).dataUrl === "string" ? (block as UiImageBlock) : null;
}

export function asBash(block: UiContentBlock): UiBashBlock | null {
	return block.type === "bash" && typeof (block as UiBashBlock).command === "string" ? (block as UiBashBlock) : null;
}

/** Editor chip kind: raster image (thumb), restored upload (uploadPath),
 *  newly-added raw file (fileData) or workspace-path attachment. */
type EditAttKind = "image" | "upload" | "file" | "path";
function editAttKind(att: PromptAttachment): EditAttKind {
	if (att.imageData) return "image";
	if (att.uploadPath) return "upload";
	if (att.fileData) return "file";
	return "path";
}

/** Tooltip label for an editor chip (reuses the chat-input attachment i18n). */
function editAttLabel(att: PromptAttachment, t: Translate): string {
	if (att.imageData) return t("attachImage", { name: att.name ?? "image" });
	if (att.uploadPath) return t("attachFile", { name: att.name ?? att.uploadPath });
	if (att.fileData) return t("attachFile", { name: att.name ?? "file" });
	const base = att.path.split("/").pop() ?? att.path;
	if (att.mode === "lines" && att.lines)
		return t("attachLines", {
			path: base,
			start: att.lines.start,
			end: att.lines.end,
		});
	if (att.mode === "reference") return t("refOnly", { path: base });
	return t("attachContent", { path: base });
}

interface MessageProps {
	message: UiMessage;
	/** toolResult messages by toolCallId (precomputed in MessageList, memoized). */
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	/** tool_status entries (tool_execution_end) by toolCallId. */
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	/** True when this is the last rendered message (stream cursor + live blocks). */
	isLast: boolean;
	/** Edit-and-re-ask handler (user messages only). Stable identity — Message is memoized.
	 *  Attachments are the images kept from the original message plus any newly
	 *  pasted/dropped ones; they re-fill the visual context the fork drops. */
	onEdit?: (messageId: string, text: string, attachments?: PromptAttachment[]) => void;
	/** Original attachments attached to this question (precomputed in MessageList
	 *  from the attachment-card run that follows it): pasted/uploaded images
	 *  (imageData), uploaded files (uploadPath) and workspace-path attachments
	 *  (path+mode) — restored in the editor because fork(entry.parent) drops
	 *  the persisted attachment asides. */
	questionAttachments?: PromptAttachment[];
	/** Kill the running bash command from its tool card (agent run continues). */
	onKillBash?: () => void;
	/** Manually retry the last failed model call (red error on the LAST message
	 *  while idle). Wired to the server `retry_last` message. */
	onRetry?: () => void;
	/** When set, shows a collapse button (message was expanded from the collapsed view). */
	onCollapse?: (messageId: string) => void;

	/** Question-nav tag (user questions only): ordinal, active highlight, jump. */
	qnIndex?: number;
	qnActive?: boolean;
	onJump?: (messageId: string) => void;
	/** 思考文本是否换行（设置面板开关；false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（设置面板开关；false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 会话内搜索打开：强制展开思考/工具卡/附件卡/技能卡——折叠内容不在
	 *  DOM，折叠层搜索索引搜到的词会“展开后看不到”。不改变用户折叠状态。 */
	searchActive?: boolean;
	/** 新插入的压缩摘要卡：首次渲染即自动展开一次，之后用户可手动收起
	 *  （收起后不再自动打开）。 */
	autoExpand?: boolean;
}

export const Message = memo(function Message({
	message,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onEdit,
	onKillBash,
	onRetry,
	onCollapse,
	questionAttachments,

	qnIndex,
	qnActive,
	onJump,
	thinkingWrap,
	toolsWrap,
	searchActive,
	autoExpand,
}: MessageProps) {
	const t = useT();
	// Inline edit-and-re-ask editor (user messages only).
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Attachments kept for the edited message: pre-filled from the original
	// message's attachment cards (fork drops persisted asides — they live on
	// the old branch past the fork point), extended by paste/drop. Mix of
	// imageData (pasted images), uploadPath (restored uploads), fileData
	// (newly added files) and path+mode (workspace attachments).
	const [editAttachments, setEditAttachments] = useState<PromptAttachment[]>([]);
	const [editDragOver, setEditDragOver] = useState(false);
	// Transient inline notice for the editor (oversized/unreadable dropped
	// files) — Message has no toast access, so it renders under the chips.
	const [editNotice, setEditNotice] = useState<string | null>(null);
	const pushEditNotice = (msg: string) => {
		setEditNotice(msg);
		window.setTimeout(() => setEditNotice((cur) => (cur === msg ? null : cur)), 4000);
	};
	// toolResult content is rendered inside its toolCall card — never standalone
	// (otherwise the same output shows twice: formatted card + plain text).
	if (message.role === "toolResult") return null;
	// Compaction summaries get a distinct collapsible card (the CLI's
	// CompactionSummaryMessageComponent counterpart): a long summary dumped as
	// a plain bubble buries what the compaction actually produced.
	if (message.role === "compactionSummary") {
		return <CompactionCard message={message} forceOpen={searchActive} autoExpand={autoExpand} />;
	}
	// Attached files are rendered as their own collapsible card, separate from
	// the user message text.
	const isFileAttachment = message.role === "custom" && message.customType === "file";
	// Dispatch worker results (async delegation): structured details render as
	// collapsed per-worker lines; malformed details fall back to the text.
	const isWorkerResult =
		message.role === "custom" &&
		message.customType === WORKER_RESULT_TYPE &&
		workerResultsFromDetails(message.details).length > 0;
	// Question text for the per-question tag's tooltip.
	const userText = message.content
		.map((b) => asText(b)?.text ?? "")
		.filter(Boolean)
		.join("\n");
	// A user message whose text is a `<skill …>` block (the SDK's /skill:name
	// expansion) renders as a compact collapsible skill card instead of dumping
	// the whole SKILL.md into the user bubble — same as the pi CLI.
	const skillBlock = message.role === "user" ? parseSkillBlock(userText) : null;
	const questionText = skillBlock
		? (skillBlock.userMessage ?? `skill:${skillBlock.name}`)
		: userText.split("\n").join(" ").trim();
	// Streaming bubble with no content yet (first token not arrived) — show a
	// visible “thinking…” placeholder instead of an invisible empty bubble.
	const isEmptyStreaming = streaming && isLast && message.content.length === 0;
	// An explicit assistant stopReason is authoritative. The narrow legacy
	// fallback keeps old transcripts readable without hiding real errors.
	const isCanceledRun = isCanceledAssistantRun(message);

	const canEdit = message.role === "user" && !streaming && !isEmptyStreaming && !!onEdit;
	/** Paste/drop handler inside the edit composer — same downscale pipeline
	 *  as the main input bar so payloads stay under the server's cap. */
	const addEditImageFiles = async (files: File[]) => {
		const added: PromptAttachment[] = [];
		for (const f of files) {
			if (!isRasterImage(f.type)) continue;
			const img = await fileToProcessedImage(f);
			if (!img) continue;
			added.push({
				path: "",
				imageData: img.data,
				mimeType: img.mimeType,
				name: img.name,
			});
		}
		if (added.length > 0) setEditAttachments((prev) => [...prev, ...added]);
	};
	/** Add a raw uploaded file (non-image, dropped in the editor) — read into
	 *  base64 fileData, same 20MB cap as the main input bar. */
	const addEditFile = async (f: File) => {
		if (f.size > MAX_EDIT_UPLOAD_BYTES) {
			pushEditNotice(t("fileTooLarge", { name: f.name, size: 20 }));
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushEditNotice(t("fileLoadFailed", { name: f.name }));
			return;
		}
		setEditAttachments((prev) => [
			...prev,
			{
				path: "",
				fileData: base64,
				name: f.name,
				size: f.size,
				mimeType: f.type || undefined,
			},
		]);
	};
	/** Add any dropped file: raster images through the resize pipeline, all
	 *  other files (incl. SVG) as raw uploads. */
	const addEditDropFiles = async (files: File[]) => {
		const imgs: File[] = [];
		for (const f of files) {
			if (isRasterImage(f.type)) imgs.push(f);
			else void addEditFile(f);
		}
		if (imgs.length > 0) await addEditImageFiles(imgs);
	};
	const startEdit = () => {
		setDraft(
			skillBlock
				? `/skill:${skillBlock.name}${skillBlock.userMessage ? ` ${skillBlock.userMessage}` : ""}`
				: message.content
						.map((b) => asText(b)?.text ?? "")
						.filter(Boolean)
						.join("\n"),
		);
		setEditAttachments(questionAttachments ?? []);
		setEditing(true);
	};
	const submitEdit = () => {
		const text = draft.trim();
		if (!text) return;
		onEdit?.(
			message.id,
			text,
			// Original attachments (images / uploads / path refs) are always
			// preserved — restoring the visual context the fork would drop; a
			// text-only edit with none stays undefined.
			editAttachments.length > 0 ? editAttachments : undefined,
		);
		setEditing(false);
	};

	// Goal-review verdict cards (server customType "goal-review") and wizard
	// progress cards ("goal-wizard") get a distinct frame so they read as goal
	// feedback rather than a plain plugin message.
	const isGoalReview =
		message.role === "custom" && (message.customType === "goal-review" || message.customType === "goal-wizard");
	const isGoalWizard = message.role === "custom" && message.customType === "goal-wizard";

	return (
		<div
			className={`msg msg-${message.role}${isGoalReview ? " msg-goal-review" : ""}`}
			data-role={message.role}
			data-msg-id={message.id}
		>
			<div className="msg-meta">
				<span className="msg-role">
					{message.role === "custom"
						? isGoalWizard
							? t("goalWizardCard")
							: isGoalReview
								? t("goalBarTitle")
								: message.customType === "file"
									? t("attachment")
									: isWorkerResult
										? t("workerResultsLabel")
										: `${t("plugin")} · ${message.customType ?? t("unknown")}`
						: roleLabel(message.role, t)}
				</span>
				{message.model && <span className="msg-model">{message.model}</span>}
				{message.timestamp && <span className="msg-time">{formatTime(message.timestamp)}</span>}
				{onCollapse && (
					<button
						type="button"
						className="msg-collapse-btn"
						title={t("collapseMsg")}
						onClick={() => onCollapse(message.id)}
					>
						<FiChevronUp /> {t("collapseMsg")}
					</button>
				)}
				{qnIndex !== undefined && onJump && (
					<button
						type="button"
						className={`qn-tag ${qnActive ? "active" : ""}`}
						title={`${qnIndex + 1}. ${questionText}`}
						aria-label={`${qnIndex + 1}. ${questionText}`}
						onClick={() => onJump(message.id)}
					>
						<span className="qn-tag-bar" />
						<span className="qn-tag-idx">{qnIndex + 1}</span>
					</button>
				)}
			</div>
			<div className="msg-body">
				{editing ? (
					<div
						className={`msg-editor${editDragOver ? " drag-over" : ""}`}
						onDragOver={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setEditDragOver(true);
						}}
						onDragLeave={(e) => {
							if (!e.currentTarget.contains(e.relatedTarget as Node)) setEditDragOver(false);
						}}
						onDrop={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setEditDragOver(false);
							void addEditDropFiles(Array.from(e.dataTransfer?.files ?? []));
						}}
					>
						{editAttachments.length > 0 && (
							<div className="msg-editor-images">
								{editAttachments.map((att, i) => {
									const kind = editAttKind(att);
									return (
										<span
											key={`${att.name ?? att.path ?? "att"}-${i}`}
											className={`msg-editor-img ${kind === "image" ? "" : "file-chip"}`}
											title={editAttLabel(att, t)}
										>
											{kind === "image" ? (
												<img src={`data:${att.mimeType ?? "image/png"};base64,${att.imageData}`} alt={att.name} />
											) : (
												<span className="msg-editor-file">
													<span className="msg-editor-file-icon">
														{kind === "path" ? (att.mode === "reference" ? "🔗" : "📎") : "📄"}
													</span>
													<span className="msg-editor-file-name">{att.name ?? att.path?.split("/").pop()}</span>
												</span>
											)}
											<button
												type="button"
												className="msg-editor-img-remove"
												title={t("removeAttachment")}
												onClick={() => setEditAttachments((prev) => prev.filter((_, j) => j !== i))}
											>
												<FiX />
											</button>
										</span>
									);
								})}
							</div>
						)}
						{editNotice && <div className="msg-editor-notice">{editNotice}</div>}
						<textarea
							className="msg-editor-input"
							value={draft}
							autoFocus
							placeholder={t("editPlaceholder")}
							rows={Math.max(2, Math.min(10, draft.split("\n").length + 1))}
							onChange={(e) => setDraft(e.target.value)}
							onPaste={(e) => {
								const images: File[] = [];
								for (const item of e.clipboardData?.items ?? []) {
									if (item.kind === "file" && isRasterImage(item.type)) {
										const f = item.getAsFile();
										if (f) images.push(f);
									}
								}
								if (images.length === 0) return; // plain text paste
								e.preventDefault();
								void addEditImageFiles(images);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									submitEdit();
								} else if (e.key === "Escape") {
									setEditing(false);
								}
							}}
						/>
						<div className="msg-editor-actions">
							<span className="msg-editor-hint">
								<FiImage /> {t("editAttachmentHint")}
							</span>
							<button type="button" className="chip" onClick={() => setEditing(false)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="chip primary"
								disabled={!draft.trim()}
								title={t("reaskFromHere")}
								onClick={submitEdit}
							>
								<FiEdit3 /> {t("reaskFromHere")}
							</button>
						</div>
					</div>
				) : (
					<>
						{message.errorMessage && !isCanceledRun && (
							<div className="msg-error">
								<span className="msg-error-text">{message.errorMessage}</span>
								{/* 最后一轮报错且已停止：给一个手动重试入口
									（自动重试次数用完，服务端 retry_last 续跑一轮） */}
								{isLast && !streaming && onRetry && (
									<button type="button" className="msg-retry-btn" title={t("retryLastTip")} onClick={onRetry}>
										{t("retryNow")}
									</button>
								)}
							</div>
						)}
						{isFileAttachment ? (
							<AttachmentCard message={message} forceOpen={searchActive} />
						) : isWorkerResult ? (
							<WorkerResultCard message={message} forceOpen={searchActive} />
						) : skillBlock ? (
							<>
								<SkillCard block={skillBlock} forceOpen={searchActive} />
								{skillBlock.userMessage && (
									<div className="msg-text">
										<Markdown text={skillBlock.userMessage} hardBreaks />
									</div>
								)}
								{message.content.map((block, i) =>
									block.type === "text" ? null : (
										<Block
											key={`${message.id}-${i}`}
											blockKey={`${message.id}-${i}`}
											block={block}
											toolResults={toolResults}
											liveOutputs={liveOutputs}
											toolStatuses={toolStatuses}
											streaming={streaming}
											isLast={isLast}
											onKillBash={onKillBash}
											toolsWrap={toolsWrap}
											thinkingWrap={thinkingWrap}
											searchActive={searchActive}
											role={message.role}
										/>
									),
								)}
							</>
						) : (
							message.content.map((block, i) => (
								<Block
									key={`${message.id}-${i}`}
									blockKey={`${message.id}-${i}`}
									block={block}
									toolResults={toolResults}
									liveOutputs={liveOutputs}
									toolStatuses={toolStatuses}
									streaming={streaming}
									isLast={isLast}
									onKillBash={onKillBash}
									toolsWrap={toolsWrap}
									thinkingWrap={thinkingWrap}
									searchActive={searchActive}
									role={message.role}
								/>
							))
						)}
						{isCanceledRun ? (
							<div className="msg-run-status msg-run-status-canceled" role="status">
								{t("canceledRun")}
							</div>
						) : (
							isEmptyStreaming && (
								<div className="thinking-wait">
									<span className="thinking-wait-label shimmer" style={shimmerPhase(message.id)}>
										{t("thinkingWait")}
									</span>
								</div>
							)
						)}
					</>
				)}
			</div>
			{canEdit && !editing && (
				<div className="msg-actions">
					<button type="button" className="msg-action" title={t("editReaskTip")} onClick={startEdit}>
						<FiEdit3 /> {t("editReask")}
					</button>
				</div>
			)}
		</div>
	);
});

/** Collapsible card for an attached file (customType "file"). */
function AttachmentCard({ message, forceOpen = false }: { message: UiMessage; forceOpen?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	// 搜索期间 forceOpen 只是“视口展开”：内容进 DOM 让搜索高亮/定位可用
	const shown = open || forceOpen;
	const details = (message.details ?? {}) as {
		name?: string;
		path?: string;
		mode?: "inline" | "reference" | "lines" | "image" | "bridged";
		size?: number;
		lines?: number;
		startLine?: number;
		endLine?: number;
		type?: "folder";
	};
	const name = details.name ?? details.path ?? t("attachment");
	const isFolder = details.type === "folder";
	const isReference = details.mode === "reference";
	const isBridged = details.mode === "bridged";

	const text = message.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const clean = stripFileWrapper(text);
	const image = message.content.find((b) => b.type === "image") as { type: "image"; dataUrl?: string } | undefined;
	const lines = clean.split("\n").length;
	const canCopy = !isReference && clean.length > 0;

	return (
		<div className={`attachcard ${isReference ? "reference" : ""}`}>
			<div
				className="chead attachcard-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={shown ? t("collapseMsg") : t("expandMsg")}
				onClick={() => setOpen((v) => (forceOpen ? true : !v))}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen((v) => (forceOpen ? true : !v));
					}
				}}
			>
				{!isReference && <span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>}
				<span className="chead-icon attachcard-icon">{isFolder ? "📁" : "📎"}</span>
				<span className="chead-title attachcard-name">{name}</span>
				{details.path && <span className="attachcard-path">{details.path}</span>}
				<span
					className={`attachcard-mode ${details.mode === "lines" ? "lines" : isReference ? "ref" : isBridged ? "bridged" : "inline"}`}
				>
					{isReference
						? isFolder
							? t("folderRefShort")
							: `${t("refOnlyShort")} · ${formatSize(details.size)}`
						: isBridged
							? t("bridgedVision")
							: image
								? t("image")
								: details.mode === "lines"
									? t("inlineLinesRange", {
											start: details.startLine ?? 1,
											end: details.endLine ?? details.lines ?? 1,
										})
									: t("inlineLines", { n: details.lines ?? lines })}
				</span>
				{canCopy && (
					<button
						type="button"
						className="chead-copy"
						title={copied ? t("copied") : t("copyMessage")}
						aria-label={t("copyMessage")}
						onClick={(e) => {
							e.stopPropagation();
							void navigator.clipboard.writeText(clean);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1200);
						}}
					>
						{copied ? <FiCheckCircle /> : <FiCopy />}
					</button>
				)}
			</div>
			{!isReference &&
				shown &&
				(isBridged ? (
					<>
						<div className="attachcard-bridgenote">{t("bridgedVisionDetail")}</div>
						{image?.dataUrl && (
							<div className="attachcard-image">
								<img src={image.dataUrl} alt={name} />
							</div>
						)}
						{clean && <pre className="attachcard-content">{clean}</pre>}
					</>
				) : image?.dataUrl ? (
					<div className="attachcard-image">
						<img src={image.dataUrl} alt={name} />
					</div>
				) : (
					<pre className="attachcard-content">{clean}</pre>
				))}
			{isReference && (
				<div className="attachcard-refnote">
					{isFolder ? t("folderNotExpanded") : t("fileNotExpanded", { size: formatSize(details.size) })}
				</div>
			)}
		</div>
	);
}

function formatSize(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** Strip the <file path="..."> ``` ... ``` </file> or <vision-bridge> ...
 * </vision-bridge> wrapper for display. */
function stripFileWrapper(text: string): string {
	const m = text.match(/^\s*<file path="[^"]*"(?:\s+lines="[^"]*")?>\s*```\s*\n?([\s\S]*?)\n?```\s*<\/file>\s*$/);
	if (m) return m[1].trim();
	const vb = text.match(/^\s*<vision-bridge>\s*([\s\S]*?)\s*<\/vision-bridge>\s*$/);
	return vb ? vb[1].trim() : text.trim();
}

/**
 * Collapsible card for a compaction summary — the web counterpart of the
 * CLI's CompactionSummaryMessageComponent. Collapsed shows "compacted from
 * N tokens" + expand affordance; expanded shows the full summary markdown
 * plus a hint that only recent messages stay in context.
 */
function CompactionCard({
	message,
	forceOpen = false,
	autoExpand = false,
}: {
	message: UiMessage;
	forceOpen?: boolean;
	autoExpand?: boolean;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	// 新摘要到达自动展开一次：render 期间同步（仅上升沿开一次是受支持的
	// React 模式），之后用户手动收起不再打扰。
	const [prevAuto, setPrevAuto] = useState(autoExpand);
	if (autoExpand !== prevAuto) {
		setPrevAuto(autoExpand);
		if (autoExpand) setExpanded(true);
	}
	const shown = expanded || forceOpen;
	const text = message.content
		.map((b) => asText(b)?.text ?? "")
		.filter(Boolean)
		.join("\n");
	const tokens = typeof message.tokensBefore === "number" ? message.tokensBefore.toLocaleString() : null;
	return (
		<div className="msg msg-compactionSummary" data-role={message.role} data-msg-id={message.id}>
			<div className="msg-meta">
				<span className="msg-role">{t("role.compaction")}</span>
				{message.timestamp && <span className="msg-time">{formatTime(message.timestamp)}</span>}
			</div>
			<div className={`compaction-card${expanded ? " expanded" : ""}`}>
				<div
					className="chead compaction-head"
					role="button"
					tabIndex={0}
					aria-expanded={shown}
					title={shown ? t("collapseMsg") : t("expandMsg")}
					onClick={() => setExpanded((v) => (forceOpen ? true : !v))}
					onKeyDown={(e) => {
						if (e.target !== e.currentTarget) return;
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							setExpanded((v) => (forceOpen ? true : !v));
						}
					}}
				>
					<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
					<span className="chead-icon compaction-icon">
						<FiArchive />
					</span>
					<span className="chead-title compaction-title">
						{tokens ? t("compactionFrom", { tokens }) : t("role.compaction")}
					</span>
					{text && (
						<button
							type="button"
							className="chead-copy"
							title={copied ? t("copied") : t("copyMessage")}
							aria-label={t("copyMessage")}
							onClick={(e) => {
								e.stopPropagation();
								void navigator.clipboard.writeText(text);
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1200);
							}}
						>
							{copied ? <FiCheckCircle /> : <FiCopy />}
						</button>
					)}
				</div>
				{shown && (
					<div className="compaction-body">
						<Markdown text={text} />
						<div className="compaction-hint">{t("compactionKeptHint")}</div>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Compact collapsible card for a skill invocation (the SDK's /skill:name
 * expansion) — the web counterpart of the CLI's SkillInvocationMessageComponent.
 * Collapsed shows a book icon + skill name + file path, expanded shows the
 * full SKILL.md content. The user's own question (args) renders separately.
 */
function SkillCard({ block, forceOpen = false }: { block: SkillBlock; forceOpen?: boolean }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const shown = expanded || forceOpen;
	return (
		<div className={`skillcard${expanded ? " expanded" : ""}`}>
			<div
				className="chead skillcard-head"
				role="button"
				tabIndex={0}
				aria-expanded={shown}
				title={block.location}
				onClick={() => setExpanded((v) => (forceOpen ? true : !v))}
				onKeyDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setExpanded((v) => (forceOpen ? true : !v));
					}
				}}
			>
				<span className="chead-toggle">{shown ? <FiChevronDown /> : <FiChevronRight />}</span>
				<span className="chead-icon skillcard-icon">
					<FiBookOpen />
				</span>
				<span className="chead-title skillcard-name">{block.name}</span>
				<span className="skillcard-path">{block.location}</span>
				<button
					type="button"
					className="chead-copy"
					title={copied ? t("copied") : t("copyMessage")}
					aria-label={t("copyMessage")}
					onClick={(e) => {
						e.stopPropagation();
						void navigator.clipboard.writeText(block.content);
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1200);
					}}
				>
					{copied ? <FiCheckCircle /> : <FiCopy />}
				</button>
			</div>
			{shown && (
				<div className="skillcard-body">
					<Markdown text={block.content} />
				</div>
			)}
		</div>
	);
}

function Block({
	block,
	blockKey,
	toolResults,
	liveOutputs,
	toolStatuses,
	streaming,
	isLast,
	onKillBash,
	thinkingWrap,
	toolsWrap,
	searchActive,
	role,
}: {
	block: UiContentBlock;
	/** Stable per-block key (message id + index) for shimmer phasing. */
	blockKey: string;
	toolResults: ReadonlyMap<string, UiMessage>;
	liveOutputs: ReadonlyMap<string, { toolName: string; text: string }>;
	toolStatuses: ReadonlyMap<string, ToolStatus>;
	streaming: boolean;
	isLast: boolean;
	onKillBash?: () => void;
	/** 思考文本是否换行（false = 不换行横向滚动）。 */
	thinkingWrap?: boolean;
	/** 工具调用是否默认展开（false = 默认折叠）。 */
	toolsWrap?: boolean;
	/** 会话内搜索打开：强制展开思考/工具卡。 */
	searchActive?: boolean;
	/** 消息角色 — assistant/user 的纯文本块显示复制按钮。 */
	role?: UiMessage["role"];
}) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const text = asText(block);
	if (text) {
		const live = streaming && isLast;
		// 单行消息：复制键不再用绝对定位压住文字，改成行内 flex 右键——与各 head
		// 同样的 6px 间距、垂直居中、28px 尺寸。多行仍用右上浮层。
		const copyable = role === "assistant" || role === "user";
		const oneLiner = copyable && !text.text.includes("\n") && !text.truncated;
		const body =
			role === "user" ? (
				// 用户自己的气泡：保留输入/粘贴时的单个换行（CommonMark 软换行会把
				// 多行纯文本折叠成连续文字）。助手消息仍走标准 markdown 段落语义。
				<Markdown text={text.text} hardBreaks />
			) : live ? (
				<StreamMarkdown text={text.text} />
			) : (
				<Markdown text={text.text} />
			);
		return (
			<div className={`msg-text${oneLiner ? " single" : ""}`}>
				{oneLiner ? (
					<div className="msg-text-main">{body}</div>
				) : (
					<>
						{body}
						{text.truncated && <div className="trunc-note">{t("truncated")}</div>}
					</>
				)}
				{copyable ? (
					<button
						type="button"
						className="msg-text-copy"
						title={copied ? t("copied") : t("copyMessage")}
						aria-label={t("copyMessage")}
						onClick={() => {
							void navigator.clipboard.writeText(text.text);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1200);
						}}
					>
						{copied ? <FiCheckCircle /> : <FiCopy />}
					</button>
				) : null}
			</div>
		);
	}

	const thinking = asThinking(block);
	if (thinking) {
		return (
			<ThinkingBlock
				thinking={thinking.thinking}
				streaming={streaming && isLast}
				wrap={thinkingWrap}
				forceOpen={searchActive}
				phaseKey={blockKey}
			/>
		);
	}

	const toolCall = asToolCall(block);
	if (toolCall) {
		const result = toolResults.get(toolCall.id);
		const live = liveOutputs.get(toolCall.id);
		const view: ToolView = {
			result,
			liveOutput: live?.text,
			streaming,
			status: toolStatuses.get(toolCall.id),
		};
		return (
			<ToolCallBlock block={toolCall} view={view} onKillBash={onKillBash} wrap={toolsWrap} forceOpen={searchActive} />
		);
	}

	const image = asImage(block);
	if (image && image.dataUrl) {
		return (
			<div className="msg-image">
				<img src={image.dataUrl} alt="attachment" />
			</div>
		);
	}

	const bash = asBash(block);
	if (bash) {
		return (
			<div className="bashblock">
				<div className="bashblock-command">
					<span className="bashblock-prompt">$</span>
					<code>{bash.command}</code>
					{bash.exitCode !== undefined && (
						<span className={`bashblock-exit ${bash.exitCode === 0 ? "ok" : "err"}`}>
							{t("exitCode", { code: bash.exitCode })}
						</span>
					)}
					{bash.cancelled && <span className="bashblock-exit err">{t("cancelled")}</span>}
				</div>
				{bash.output && <pre className="bashblock-output">{bash.output}</pre>}
				{bash.truncated && <div className="trunc-note">{t("outputTruncated")}</div>}
			</div>
		);
	}

	return null;
}

/** True only for an assistant run canceled by the user/engine. Keep the
 * legacy text match intentionally narrow: arbitrary error text must remain a
 * real error, especially when the transcript explicitly says stopReason=error. */
export function isCanceledAssistantRun(message: UiMessage): boolean {
	if (message.role !== "assistant") return false;
	if (message.stopReason === "aborted") return true;
	if (message.stopReason) return false;
	const error = message.errorMessage?.trim().toLowerCase();
	return error === "request was aborted" || error === "request aborted";
}

export function roleLabel(role: string, t: Translate): string {
	switch (role) {
		case "user":
			return t("role.user");
		case "assistant":
			return t("role.assistant");
		case "toolResult":
			return t("role.tool");
		case "bashExecution":
			return t("role.bash");
		case "branchSummary":
			return t("role.branch");
		case "compactionSummary":
			return t("role.compaction");
		default:
			return role;
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}
