import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
	FiArrowLeft,
	FiCheck,
	FiCode,
	FiCornerDownLeft,
	FiEdit3,
	FiEye,
	FiLink,
	FiMaximize,
	FiMinimize,
	FiPlus,
	FiSave,
	FiX,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import type { FileContent } from "../types";
import { Markdown } from "./Markdown";
import { useT } from "../i18n";
import { highlightFile } from "../highlight-lines";
import { getClientId } from "../use-chat";
import { withToken } from "../auth-token";
import { appUrl } from "../base-url";
import { appSend } from "../app-globals";

/** Cap rendered lines so a pathological file can't freeze the modal. */
const MAX_PREVIEW_LINES = 5000;

export interface PreviewFile {
	path: string;
	name: string;
}

interface FilePreviewProps {
	file: PreviewFile;
	/** Latest file content from the server (path-matched inside the modal). */
	content: FileContent | null;
	/** Add the selected line range as a "lines" attachment to the chat input. */
	onAddLines: (path: string, name: string, start: number, end: number) => void;
	/** Attach the whole file (inline content / path reference) like the row buttons. */
	onAttach: (path: string, name: string, mode: "inline" | "reference") => void;
	onClose: () => void;
	/** Inline mode: render as a fill-the-container workspace pane (no fixed
	 *  overlay / backdrop dismiss) — used by the right workspace panel. */
	inline?: boolean;
}

/** 1-based inclusive line range. */
interface Range {
	start: number;
	end: number;
}

export function FilePreview({ file, content, onAddLines, onAttach, onClose, inline = false }: FilePreviewProps) {
	const t = useT();
	const [loaded, setLoaded] = useState<FileContent | null>(null);
	const [loading, setLoading] = useState(false);
	const [sel, setSel] = useState<Range | null>(null);
	const [dragging, setDragging] = useState(false);
	const [added, setAdded] = useState(false);
	// Editing is deliberately opt-in for every newly opened file.
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Markdown files open in rendered view; raw source remains one click away.
	const [markdownPreview, setMarkdownPreview] = useState(true);
	// Same for HTML files: sandboxed iframe render by default, source on toggle.
	const [htmlPreview, setHtmlPreview] = useState(true);
	// HTML preview script gate: off by default (pure static render). Turning it
	// on is an explicit per-file opt-in — resets on file switch, never persisted.
	const [allowJs, setAllowJs] = useState(false);
	const editViewRef = useRef(false);
	// Word wrap for the text preview (default on).
	const [wrap, setWrap] = useState(true);
	// Fullscreen fills the whole viewport; zoom scales the preview body
	// (font-size for code/editor/hex, CSS zoom for the rendered markdown).
	const [fullscreen, setFullscreen] = useState(false);
	const [zoom, setZoom] = useState(100);
	const anchorRef = useRef(0);
	const draggingRef = useRef(false);
	const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Request content on open / file change (mount included).
	useEffect(() => {
		setLoading(true);
		setLoaded(null);
		setSel(null);
		setEditing(false);
		setDraft("");
		setMarkdownPreview(true);
		setHtmlPreview(true);
		setAllowJs(false);
		editViewRef.current = false;
		appSend({ type: "read_file", path: file.path });
	}, [file.path]);

	// Accept responses only for the file currently shown (stale responses for
	// previously previewed files are ignored).
	useEffect(() => {
		if (content && content.path === file.path) {
			setLoaded(content);
			if (!editing) setDraft(content.text);
			setLoading(false);
		}
	}, [content, editing, file.path]);

	// Escape closes; Ctrl/Cmd+A selects everything in the preview.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				handleClose();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && editing) {
				e.preventDefault();
				saveEditing();
				return;
			}
			const target = e.target as HTMLElement | null;
			const typing =
				target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing) {
				e.preventDefault();
				selectAll();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose, loaded, editing, draft]);

	// End drag selection on mouseup anywhere.
	useEffect(() => {
		const up = () => {
			draggingRef.current = false;
			setDragging(false);
		};
		window.addEventListener("mouseup", up);
		return () => window.removeEventListener("mouseup", up);
	}, []);

	const lines = useMemo(() => {
		if (!loaded) return [];
		const parts = loaded.text.split("\n");
		// Trailing newline → empty phantom line; drop it so line numbers match
		// what the server counts.
		if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
		return parts.slice(0, MAX_PREVIEW_LINES);
	}, [loaded]);
	/** Highlighted HTML of the edit draft (whole document, joined back with
	 *  newlines) for the editor underlay. Re-runs per keystroke; highlight.js is
	 *  linear and highlightFile() falls back to plain above HIGHLIGHT_MAX_BYTES. */
	const draftHtml = useMemo(
		() => (editing ? highlightFile(draft, file.name).lines.join("\n") : ""),
		[editing, draft, file.name],
	);
	const editorHlRef = useRef<HTMLPreElement>(null);
	// Per-line highlighted HTML, aligned 1:1 with `lines` (same trailing-line
	// and preview-cap rules). Binary and oversized files come back plain.
	const highlighted = useMemo(() => {
		if (!loaded || loaded.kind !== "text" || loaded.binary) return null;
		const out = highlightFile(loaded.text, file.name).lines;
		if (out.length > 0 && out[out.length - 1] === "") out.pop();
		return out.slice(0, MAX_PREVIEW_LINES);
	}, [loaded, file.name]);

	const lineCount = loaded?.lines ?? 0;
	const truncatedLines = lineCount > MAX_PREVIEW_LINES;

	const selectLine = (line: number, extend: boolean) => {
		if (extend) {
			const anchor = anchorRef.current > 0 ? anchorRef.current : line;
			setSel({
				start: Math.min(anchor, line),
				end: Math.max(anchor, line),
			});
		} else {
			anchorRef.current = line;
			setSel({ start: line, end: line });
		}
	};

	const selectAll = () => {
		if (lines.length === 0) return;
		anchorRef.current = 1;
		setSel({ start: 1, end: lines.length });
	};

	const addToChat = () => {
		if (!sel) return;
		onAddLines(file.path, file.name, sel.start, sel.end);
		setAdded(true);
		if (addedTimer.current) clearTimeout(addedTimer.current);
		addedTimer.current = setTimeout(() => setAdded(false), 1400);
	};

	const canEdit = loaded !== null && loaded.kind === "text" && !loaded.binary && !loaded.truncated;

	const cancelEditing = () => {
		setDraft(loaded?.text ?? "");
		setEditing(false);
		if (editViewRef.current) {
			if (isMarkdownFile(file.name)) setMarkdownPreview(true);
			if (isHtmlFile(file.name)) setHtmlPreview(true);
		}
	};

	const toggleEditing = () => {
		if (editing) {
			if (draft !== (loaded?.text ?? "") && !window.confirm(t("discardFileChanges"))) {
				return;
			}
			cancelEditing();
			return;
		}
		if (!canEdit || !loaded) return;
		editViewRef.current = (isMarkdownFile(file.name) && markdownPreview) || (isHtmlFile(file.name) && htmlPreview);
		if (isMarkdownFile(file.name)) setMarkdownPreview(false);
		if (isHtmlFile(file.name)) setHtmlPreview(false);
		setSel(null);
		setDraft(loaded.text);
		setEditing(true);
	};

	const saveEditing = () => {
		if (!editing || !loaded || !canEdit) return;
		if (!appSend({ type: "write_file", path: file.path, text: draft })) return;
		setEditing(false);
		if (editViewRef.current) {
			if (isMarkdownFile(file.name)) setMarkdownPreview(true);
			if (isHtmlFile(file.name)) setHtmlPreview(true);
		}
		setSel(null);
	};

	const handleClose = () => {
		if (editing && draft !== (loaded?.text ?? "") && !window.confirm(t("discardFileChanges"))) {
			return;
		}
		onClose();
	};

	const setZoomLevel = (next: number) => {
		setZoom(Math.min(200, Math.max(50, next)));
	};

	const selCount = sel ? sel.end - sel.start + 1 : 0;
	const isBinary = loaded?.binary ?? false;
	const truncated = loaded?.truncated ?? false;
	// Preview category from the server ("text" while loading). Media kinds are
	// streamed over the /api/file HTTP endpoint; "none" is never previewable.
	const kind = loaded?.kind ?? "text";
	const isMarkdown = isMarkdownFile(file.name);
	const isHtml = isHtmlFile(file.name);
	const showMarkdown = isMarkdown && markdownPreview && !editing && kind === "text" && !isBinary;
	const showHtml = isHtml && htmlPreview && !editing && kind === "text" && !isBinary;
	// /api/file resolves against the requesting client's workspace (the opened
	// project), not the server's startup cwd — pass clientId so they can differ.
	const mediaUrl = (p: string) =>
		withToken(appUrl(`/api/file?clientId=${encodeURIComponent(getClientId())}&path=${encodeURIComponent(p)}`));
	// HTML render URL: directory-mapped /api/preview so the page's RELATIVE
	// subresources (<link href="../web/src/styles.css">, ./app.js, images…)
	// resolve against the file's own directory. ?allowJs=1 lifts the script
	// block (server CSP + iframe sandbox switch together).
	const htmlUrl = (p: string) => {
		const segs = p
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		// Machine browsing sends absolute wire paths ("C:/..." / "/...");
		// workspace-relative paths never start with "/" or a drive letter.
		const abs = /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("/");
		const base = abs ? `/api/preview/__abs__/${segs}` : `/api/preview/${segs}`;
		return withToken(appUrl(`${base}?clientId=${encodeURIComponent(getClientId())}${allowJs ? "&allowJs=1" : ""}`));
	};

	return (
		<div
			className={`${inline ? "fp-inline" : "fp-overlay"} ${fullscreen ? "fullscreen" : ""}`}
			onMouseDown={(e) => {
				if (!inline && e.target === e.currentTarget) handleClose();
			}}
		>
			<div className={`fp ${fullscreen ? "fullscreen" : ""}`} style={{ "--fp-zoom": zoom / 100 } as CSSProperties}>
				<div className="fp-head">
					<span className="fp-name" title={file.path}>
						{file.name}
					</span>
					<span className="fp-path">{file.path}</span>
					<span className="fp-meta">
						{loaded && kind === "text" && !isBinary && t("fileLines", { n: lineCount })}
						{loaded && ` · ${formatSize(loaded.size)}`}
					</span>
					<span className="fp-head-actions">
						{/* 内嵌模式：第一个按钮 = 返回文件树（等同关闭预览），给窄栏一个
						    明确的「回去」路径，而不是只靠右上角 ✕。 */}
						{inline && (
							<button type="button" className="fp-attach back" title={t("fpBack")} onClick={handleClose}>
								<FiArrowLeft />
							</button>
						)}
						{isMarkdown && kind === "text" && !isBinary && loaded && (
							<button
								type="button"
								className={`fp-attach markdown ${markdownPreview ? "on" : ""}`}
								data-tip={markdownPreview ? t("showMarkdownSource") : t("showMarkdownPreview")}
								disabled={editing}
								onClick={() => setMarkdownPreview((value) => !value)}
							>
								{markdownPreview ? <FiEye /> : <FiCode />}
							</button>
						)}
						{isHtml && kind === "text" && !isBinary && loaded && (
							<button
								type="button"
								className={`fp-attach html ${htmlPreview ? "on" : ""}`}
								data-tip={htmlPreview ? t("showHtmlSource") : t("showHtmlPreview")}
								disabled={editing}
								onClick={() => setHtmlPreview((value) => !value)}
							>
								{htmlPreview ? <FiCode /> : <FiEye />}
							</button>
						)}
						{kind === "text" && !isBinary && loaded && (
							<button
								type="button"
								className={`fp-attach edit ${editing ? "on" : ""}`}
								data-tip={truncated ? t("fileEditTruncated") : editing ? t("exitEditFile") : t("editFile")}
								disabled={!canEdit && !editing}
								onClick={toggleEditing}
							>
								<FiEdit3 />
							</button>
						)}
						{kind === "text" && !isBinary && !showMarkdown && !showHtml && (
							<button
								type="button"
								className={`fp-attach wrap ${wrap ? "on" : ""}`}
								data-tip={wrap ? t("disableWrap") : t("enableWrap")}
								onClick={() => setWrap((w) => !w)}
							>
								<FiCornerDownLeft />
							</button>
						)}
						{kind === "text" && loaded && (
							<span className="fp-zoom">
								<button
									type="button"
									className="fp-attach zoom-out"
									data-tip={t("zoomOut")}
									disabled={zoom <= 50}
									onClick={() => setZoomLevel(zoom - 10)}
								>
									<FiZoomOut />
								</button>
								<button type="button" className="fp-zoom-val" title={t("resetZoom")} onClick={() => setZoom(100)}>
									{zoom}%
								</button>
								<button
									type="button"
									className="fp-attach zoom-in"
									data-tip={t("zoomIn")}
									disabled={zoom >= 200}
									onClick={() => setZoomLevel(zoom + 10)}
								>
									<FiZoomIn />
								</button>
							</span>
						)}
						{kind !== "video" && kind !== "none" && (
							<button
								type="button"
								className="fp-attach inline"
								data-tip={t("attachInlineTip")}
								onClick={() => onAttach(file.path, file.name, "inline")}
							>
								<FiPlus />
							</button>
						)}
						<button
							type="button"
							className="fp-attach ref"
							data-tip={t("referenceTip")}
							onClick={() => onAttach(file.path, file.name, "reference")}
						>
							<FiLink />
						</button>
						<button
							type="button"
							className={`fp-attach full ${fullscreen ? "on" : ""}`}
							data-tip={fullscreen ? t("exitFullscreen") : t("fullscreen")}
							onClick={() => setFullscreen((f) => !f)}
						>
							{fullscreen ? <FiMinimize /> : <FiMaximize />}
						</button>
						<button type="button" className="fp-close" title={t("close")} onClick={handleClose}>
							<FiX />
						</button>
					</span>
				</div>

				{truncated && kind === "text" && !isBinary && <div className="fp-notice">{t("previewTruncated")}</div>}

				{loading && !loaded && <div className="fp-empty">{t("loading")}</div>}

				{!loading && kind === "none" && !isBinary && <div className="fp-empty">{t("previewNotSupported")}</div>}

				{!loading && kind === "image" && (
					<div className="fp-media-wrap">
						<img className="fp-media" src={mediaUrl(file.path)} alt={file.name} />
					</div>
				)}

				{!loading && kind === "video" && (
					<div className="fp-media-wrap">
						<video className="fp-media" src={mediaUrl(file.path)} controls preload="metadata" />
					</div>
				)}

				{!loading && showHtml && loaded && (
					<div className="fp-html">
						<div className="fp-html-bar">
							<span className="fp-html-hint" title={t(allowJs ? "htmlJsOnTip" : "htmlJsOffTip")}>
								{allowJs ? t("htmlJsOn") : t("htmlJsOff")}
							</span>
							<button
								type="button"
								className={`fp-html-js ${allowJs ? "on" : ""}`}
								data-tip={allowJs ? t("htmlDisableJs") : t("htmlEnableJs")}
								onClick={() => setAllowJs((v) => !v)}
							>
								{allowJs ? t("htmlDisableJs") : t("htmlEnableJs")}
							</button>
						</div>
						<iframe
							// key forces a reload when the gate flips (script blocking is
							// decided at document load — toggling attributes alone reuses
							// the already-parsed page).
							key={allowJs ? "js" : "nojs"}
							className="fp-html-frame"
							src={htmlUrl(file.path)}
							title={file.name}
							// No allow-same-origin, ever: even with scripts on, the page
							// runs in an opaque origin — no access to our DOM, cookies,
							// storage; forms and top-navigation stay blocked too.
							sandbox={allowJs ? "allow-scripts" : ""}
							referrerPolicy="no-referrer"
						/>
					</div>
				)}

				{!loading && showMarkdown && loaded && (
					<div className="fp-markdown msg-text">
						<div className="fp-markdown-zoom">
							<Markdown text={loaded.text} />
						</div>
					</div>
				)}

				{!loading && isBinary && kind !== "image" && kind !== "video" && loaded && (
					<div className="fp-hex-wrap">
						<div className="fp-notice">
							{t("binaryFile")}
							{loaded.truncated && t("binaryHexTruncated")}
						</div>
						<pre className="fp-hex">{loaded.text}</pre>
					</div>
				)}

				{!loading && editing && kind === "text" && !isBinary && loaded && (
					// Highlighted editor: the textarea keeps input, selection and the
					// caret but paints its text transparent; a <pre> with the same
					// metrics sits underneath showing the highlighted draft, scroll-
					// synced so the two never drift.
					<div className={`fp-editor-wrap ${wrap ? "" : "no-wrap"}`}>
						<pre
							ref={editorHlRef}
							className="fp-editor-hl hljs"
							aria-hidden="true"
							// highlight.js output: text already escaped, only span tags
							dangerouslySetInnerHTML={{ __html: `${draftHtml}\n` }}
						/>
						<textarea
							className="fp-editor"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onScroll={(e) => {
								const hl = editorHlRef.current;
								if (!hl) return;
								hl.scrollTop = e.currentTarget.scrollTop;
								hl.scrollLeft = e.currentTarget.scrollLeft;
							}}
							wrap={wrap ? "soft" : "off"}
							spellCheck={false}
							autoFocus
						/>
					</div>
				)}

				{!loading &&
					!showMarkdown &&
					!showHtml &&
					!editing &&
					kind === "text" &&
					!isBinary &&
					loaded &&
					lines.length === 0 && <div className="fp-empty">{t("emptyFile")}</div>}

				{!loading && !showMarkdown && !showHtml && !editing && kind === "text" && !isBinary && lines.length > 0 && (
					<div
						className={`fp-code ${dragging ? "dragging" : ""} ${wrap ? "" : "no-wrap"}`}
						onMouseDown={(e) => {
							// Block native text selection so click/drag maps to line ranges.
							if (e.button === 0) e.preventDefault();
						}}
					>
						{lines.map((text, i) => {
							const n = i + 1;
							const active = sel !== null && n >= sel.start && n <= sel.end;
							return (
								<div
									key={n}
									className={`fp-line ${active ? "sel" : ""}`}
									onMouseDown={(e) => {
										if (e.button !== 0) return;
										selectLine(n, e.shiftKey);
										draggingRef.current = true;
										setDragging(true);
									}}
									onMouseEnter={() => {
										if (draggingRef.current) selectLine(n, true);
									}}
								>
									<span className="fp-num">{n}</span>
									{highlighted && highlighted[i] !== undefined ? (
										// highlight.js output: text already escaped, only span tags
										<span className="fp-code-text hljs" dangerouslySetInnerHTML={{ __html: highlighted[i] }} />
									) : (
										<span className="fp-code-text">{text}</span>
									)}
								</div>
							);
						})}
						{truncatedLines && (
							<div className="fp-lines-note">{t("previewLinesTruncated", { n: MAX_PREVIEW_LINES })}</div>
						)}
					</div>
				)}

				<div className="fp-foot">
					{editing ? (
						<>
							<span className="fp-hint">{t("editFile")}</span>
							<div className="fp-actions">
								<button type="button" className="btn" onClick={toggleEditing}>
									{t("cancel")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={draft === (loaded?.text ?? "")}
									onClick={saveEditing}
								>
									<FiSave /> {t("saveFile")}
								</button>
							</div>
						</>
					) : (
						!showMarkdown &&
						!showHtml &&
						kind === "text" && (
							<>
								<span className="fp-hint">
									{sel
										? t("selectedRange", {
												n: selCount,
												start: sel.start,
												end: sel.end,
											})
										: t("selectLinesHint")}
								</span>
								<div className="fp-actions">
									<button type="button" className="btn" disabled={lines.length === 0} onClick={selectAll}>
										{t("selectAll")}
									</button>
									<button type="button" className="btn" disabled={!sel} onClick={() => setSel(null)}>
										{t("clearSelection")}
									</button>
									<button type="button" className="btn primary" disabled={!sel || isBinary} onClick={addToChat}>
										{added ? <FiCheck /> : null}
										{added ? t("addedToChat") : t("addToChat")}
									</button>
								</div>
							</>
						)
					)}
				</div>
			</div>
		</div>
	);
}

function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isHtmlFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
