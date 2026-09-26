import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
	FiCheck,
	FiChevronRight,
	FiChevronsRight,
	FiClipboard,
	FiCopy,
	FiDownload,
	FiFile,
	FiFolder,
	FiLink,
	FiMaximize2,
	FiPlus,
	FiUpload,
	FiX,
} from "react-icons/fi";
import type { ClientMessage, FileListing } from "../types";
import { useT } from "../i18n";
import { useAppField } from "../app-globals";
import { downloadFile, DOWNLOAD_FILE_NOT_FOUND } from "../download";
import { applySashDrag, parseWeights } from "../panel-sash";

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
const MACHINE_ROOT = "@root";

/** 右栏纵向分割（文件区 ↔ widgets）的默认权重与最小高度 —— 与左栏同一套权重模型。 */
const LS_RP_SIZES = "pi-web-ui:rp-sizes";
type RpWeights = { files: number; widgets: number };
const DEFAULT_RP_WEIGHTS: RpWeights = { files: 4, widgets: 1 };
const RP_MIN_FILES_PX = 120;
const RP_MIN_WIDGETS_PX = 56;

type AttachMode = "inline" | "reference";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  re-reconciling the file tree on every delta. */
interface RightPanelProps {
	files: FileListing | null;
	/** Last dir-changed push (path = listed directory) — triggers a refresh. */
	fileChanged: { path: string } | null;
	widgets: { key: string; lines: string[] }[];
	panelSend: (msg: ClientMessage) => boolean;
	/** Called when the user clicks an attach button on a file or folder. */
	onAttach: (path: string, name: string, mode: AttachMode, isDir?: boolean) => void;
	/** Called when the user clicks a file to open the preview modal. */
	onPreview: (path: string, name: string) => void;
	/** Show a transient toast (download errors etc.). */
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;
}

export const RightPanel = memo(function RightPanel({
	files,
	fileChanged,
	widgets,
	panelSend,
	onAttach,
	onPreview,
	onNotice,
	collapsible,
	onToggleCollapse,
}: RightPanelProps) {
	const t = useT();
	// 当前工作目录：走全局（web/src/app-globals.ts），不再从 App 传。
	const cwd = useAppField("cwd");
	const [currentPath, setCurrentPath] = useState<string>("");
	// 点击放大的 widget（居中浮层展示完整宽度输出）。
	const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	// ---- 文件区 ↔ widgets 的纵向分割（与左栏 VSCode 风格分割同款：拖动改权重、双击复位） ----
	const panelRef = useRef<HTMLElement>(null);
	const crumbsRef = useRef<HTMLDivElement>(null);
	const [rpWeights, setRpWeights] = useState<RpWeights>(() => {
		try {
			return parseWeights(localStorage.getItem(LS_RP_SIZES), DEFAULT_RP_WEIGHTS);
		} catch {
			return { ...DEFAULT_RP_WEIGHTS };
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(LS_RP_SIZES, JSON.stringify(rpWeights));
		} catch {}
	}, [rpWeights]);
	const hasWidgets = widgets.some((w) => w.lines.length > 0);
	const onSashDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const panel = panelRef.current;
			if (!panel) return;
			const target = e.currentTarget;
			const startY = e.clientY;
			const start = { above: rpWeights.files, below: rpWeights.widgets };
			// 面包屑是固定高的头部（不参与权重）：可用高度要扣掉它
			const available = Math.max(120, panel.clientHeight - (crumbsRef.current?.offsetHeight ?? 32));
			target.classList.add("dragging");
			document.body.classList.add("rp-resizing");
			const onMove = (ev: PointerEvent) => {
				const { above, below } = applySashDrag({
					start,
					deltaPx: ev.clientY - startY,
					availablePx: available,
					totalWeight: start.above + start.below,
					minAbovePx: RP_MIN_FILES_PX,
					minBelowPx: RP_MIN_WIDGETS_PX,
				});
				setRpWeights({ files: above, widgets: below });
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				target.classList.remove("dragging");
				document.body.classList.remove("rp-resizing");
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[rpWeights.files, rpWeights.widgets],
	);

	// ---- Right-click context menu ------------------------------------
	// Menu shows at (x, y); dir = the dir uploaded files land in ("" = root).
	// project = "open as project" target for folder rows (null elsewhere).
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
	const ctxDir = useRef("");
	const ctxProject = useRef<{ path: string; name: string } | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	// ---- 复制名称 / 复制路径（hover 显示，点后 ✓ 1.2s 回显） ----
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		// 卸载时清掉回显 timer，避免 setState 落到已卸载组件。
		return () => {
			if (copyTimer.current) clearTimeout(copyTimer.current);
		};
	}, []);

	const markCopied = useCallback((key: string) => {
		setCopiedKey(key);
		if (copyTimer.current) clearTimeout(copyTimer.current);
		copyTimer.current = setTimeout(() => setCopiedKey(null), 1200);
	}, []);

	/** 非安全上下文（http）下 navigator.clipboard 可能缺失，走 textarea 兜底。 */
	const fallbackCopy = (text: string): boolean => {
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand("copy");
			document.body.removeChild(ta);
			return ok;
		} catch {
			return false;
		}
	};

	const copyText = useCallback(
		(text: string, key: string) => {
			if (!text) return;
			const done = () => markCopied(key);
			const fail = () => onNotice("error", t("slashCopyFailed"));
			const nav = navigator as Navigator & { clipboard?: Clipboard };
			if (nav.clipboard?.writeText) {
				void nav.clipboard.writeText(text).then(done, () => {
					if (fallbackCopy(text)) done();
					else fail();
				});
			} else if (fallbackCopy(text)) done();
			else fail();
		},
		[markCopied, onNotice, t],
	);

	/** 复制用的绝对路径：机器浏览已是绝对路径直接用；工作区相对路径拼上 cwd。 */
	const absPathOf = useCallback(
		(p: string): string => {
			if (!p) return cwd;
			if (/^[A-Za-z]:$/.test(p)) return `${p}/`;
			if (p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p)) return p;
			const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			return root ? `${root}/${p}` : p;
		},
		[cwd],
	);

	/** 文件夹行 → set_cwd 可用的绝对路径：机器浏览（绝对 wire 路径）直接用；
	 *  工作区相对路径拼上 cwd；机器根本身不能作项目。 */
	const toProjectPath = useCallback(
		(p: string): string | null => {
			if (!p || p === MACHINE_ROOT) return null;
			if (p.startsWith("/") || /^[A-Za-z]:([/]|$)/.test(p)) return p;
			const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			return `${root}/${p}`;
		},
		[cwd],
	);

	/** Right-click on the blank panel body or a file entry → upload into the
	 *  currently LISTED directory; right-click on a folder row → upload into
	 *  THAT folder (same action, different target) + "open as project". */
	const openCtxMenu = useCallback(
		(e: React.MouseEvent, dir: string, project?: { path: string; name: string } | null) => {
			e.preventDefault();
			ctxDir.current = dir;
			ctxProject.current = project ?? null;
			setCtxMenu({
				x: Math.min(e.clientX, window.innerWidth - 220),
				y: Math.min(e.clientY, window.innerHeight - 90),
			});
		},
		[],
	);

	const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

	// Dismiss on outside click, Escape, scroll or resize.
	useEffect(() => {
		if (!ctxMenu) return;
		// 菜单内部点击不关闭：否则 mousedown（捕获）先关菜单、按钮先卸载，
		// 后面的 click 事件落不到按钮上，点「上传」没反应。
		const onDown = (e: MouseEvent) => {
			if ((e.target as Element | null)?.closest(".ctx-menu")) return;
			closeCtxMenu();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeCtxMenu();
		};
		window.addEventListener("mousedown", onDown, true);
		window.addEventListener("keydown", onKey);
		// blur 的 listener 参数是 FocusEvent——包一层不用参数，与 onDown 分离。
		const onBlur = () => closeCtxMenu();
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("mousedown", onDown, true);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", onBlur);
		};
	}, [ctxMenu, closeCtxMenu]);

	/** 文件夹右键「以项目打开」→ 整个工作区切过去（set_cwd）。 */
	const openAsProject = useCallback(() => {
		const p = ctxProject.current;
		closeCtxMenu();
		if (p) panelSend({ type: "set_cwd", path: p.path });
	}, [closeCtxMenu, panelSend]);

	/** Open the hidden file picker; the picked files are uploaded into ctxDir. */
	const pickFiles = useCallback(() => {
		closeCtxMenu();
		// Reset so picking the same file twice still fires change.
		if (fileInput.current) fileInput.current.value = "";
		fileInput.current?.click();
	}, [closeCtxMenu]);

	/** 把一批 File 上传到指定目录（右键菜单与拖拽共用）。 */
	const uploadFilesTo = useCallback(
		(dir: string, files: File[]) => {
			for (const f of files) {
				const fr = new FileReader();
				fr.onload = () => {
					const dataUrl = fr.result as string;
					const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
					if (b64) panelSend({ type: "upload_file", dirPath: dir, name: f.name, data: b64 });
				};
				fr.readAsDataURL(f);
			}
		},
		[panelSend],
	);

	const uploadPicked = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			uploadFilesTo(ctxDir.current, Array.from(e.target.files ?? []));
		},
		[uploadFilesTo],
	);

	// ---- 拖拽上传（类 VSCode：文件夹行→该文件夹；文件行→其所在目录；空白→当前目录） ----
	// 高亮用命令式 DOM class（不触发 React 重渲染），与逐行 data-path 配合。
	const bodyRef = useRef<HTMLDivElement>(null);

	const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

	const clearDropHl = useCallback(() => {
		bodyRef.current?.querySelectorAll(".file-item.drop-target").forEach((el) => el.classList.remove("drop-target"));
		bodyRef.current?.classList.remove("drop-root");
	}, []);

	const setDropHl = useCallback(
		(dir: string | null) => {
			clearDropHl();
			if (dir == null) return;
			const row = bodyRef.current?.querySelector(`.file-item[data-path="${CSS.escape(dir)}"]`);
			if (row) row.classList.add("drop-target");
			else bodyRef.current?.classList.add("drop-root");
		},
		[clearDropHl],
	);

	/** 拖拽落点目录：命中文件夹行→该文件夹；文件行/未知行/空白→当前列表目录。 */
	const dropDirFor = (target: EventTarget | null): string => {
		const el = target instanceof Element ? (target.closest(".file-item") as HTMLElement | null) : null;
		if (el?.dataset.type === "dir") return el.dataset.path ?? currentPath;
		return currentPath;
	};

	/** 主应用把全窗口当拖放目标（拖文件即「附加到对话」）；面板自己处理时要
	 *  清掉它的全屏 📎 提示，避免盖在上传落点上方造成歧义（纯视觉清理）。 */
	const clearAppDrop = useCallback(() => {
		const appEl = document.querySelector(".app");
		if (appEl) appEl.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
	}, []);

	/** How often to silently re-poll the current directory (ms). */
	const AUTO_REFRESH_MS = 10_000;

	// Monotonic request id — responses are only trusted if they match the latest
	// requested path (guards against out-of-order responses when navigating fast).
	const reqSeq = useRef(0);

	// Last cwd we listed — when the workspace switches, jump back to its root.
	const lastCwd = useRef<string | undefined>(undefined);

	const request = useCallback(
		(path: string, opts?: { silent?: boolean }) => {
			const seq = ++reqSeq.current;
			setCurrentPath(path);
			// Silent refreshes (polling / cwd switch) keep the current listing on
			// screen instead of flashing the loading placeholder.
			if (!opts?.silent) setLoading(true);
			const ok = panelSend({
				type: "list_files",
				path: path === "" ? undefined : path,
			});
			if (!ok) {
				// Not connected — nothing will arrive; back off the spinner.
				if (reqSeq.current === seq) setLoading(false);
			}
		},
		[panelSend],
	);

	// The server response arrives via chat.files; only treat it as the answer to
	// the current navigation if its path matches (stale/out-of-order responses
	// for other directories keep the spinner up).
	useEffect(() => {
		if (files && files.path === currentPath) setLoading(false);
	}, [files, currentPath]);

	// Auto-refresh: when the cwd changes (project switch / set_cwd) re-list its
	// root; otherwise poll the current directory silently so the tree stays fresh
	// without a manual refresh button.
	useEffect(() => {
		if (cwd !== lastCwd.current) {
			lastCwd.current = cwd;
			request("", { silent: true });
			return;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			request(currentPath, { silent: true });
		}, AUTO_REFRESH_MS);
		return () => clearInterval(timer);
	}, [cwd, currentPath, request]);
	// The server fs.watches the listed directory and pushes `file_changed` on any
	// change — refresh right away instead of waiting for the 10s poll. The path
	// guard drops events for a directory the user has already navigated away from.
	useEffect(() => {
		if (fileChanged && fileChanged.path === currentPath) request(currentPath, { silent: true });
	}, [fileChanged, currentPath, request]);

	// Enter a directory.
	const openDir = (path: string) => request(path);
	// Go back to the parent.
	const goUp = () => {
		if (files?.parent !== null && files?.parent !== undefined) {
			request(files.parent);
		}
	};

	// 面包屑：工作区相对路径按 "/" 逐级；Windows 绝对路径（C:/a/b）首级就是盘符；
	// posix 绝对路径补 "/" 根；机器根（@root）不进面包屑（有专门的 💻 按钮）。
	const crumbs = (() => {
		if (currentPath === "" || currentPath === MACHINE_ROOT) return [];
		const parts = currentPath.split("/").filter((c) => Boolean(c) && c !== MACHINE_ROOT);
		if (currentPath.startsWith("/")) {
			return parts.map((_p, i) => ({
				label: i === 0 ? "/" : parts[i],
				path: "/" + parts.slice(0, i + 1).join("/"),
			}));
		}
		return parts.map((_p, i) => ({ label: parts[i], path: parts.slice(0, i + 1).join("/") }));
	})();

	return (
		<aside className="panel panel-right" ref={panelRef}>
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronsRight />
				</button>
			)}
			<div className="panel-crumbs" ref={crumbsRef}>
				<button type="button" className={`crumb ${currentPath === "" ? "active" : ""}`} onClick={() => request("")}>
					{t("rootDir")}
				</button>
				<button
					type="button"
					className={`crumb ${currentPath === MACHINE_ROOT ? "active" : ""}`}
					title={t("computer")}
					onClick={() => request(MACHINE_ROOT)}
				>
					💻
				</button>
				{crumbs.map((c) => (
					<span key={c.path} className="crumb-seg">
						<FiChevronRight />
						<button
							type="button"
							className={`crumb ${c.path === currentPath ? "active" : ""}`}
							onClick={() => request(c.path)}
						>
							{c.label}
						</button>
					</span>
				))}
			</div>
			<div
				ref={bodyRef}
				className="panel-body"
				style={hasWidgets ? { flexGrow: rpWeights.files, minHeight: RP_MIN_FILES_PX } : undefined}
				onContextMenu={(e) => openCtxMenu(e, currentPath)}
				onDragOver={(e) => {
					if (!isFileDrag(e)) return;
					e.preventDefault(); // 声明合法落点，否则浏览器默认禁止 drop
					e.stopPropagation(); // 主应用全窗口「附加到对话」不参与
					e.dataTransfer.dropEffect = "copy";
					clearAppDrop();
					setDropHl(dropDirFor(e.target));
				}}
				onDragLeave={(e) => {
					if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
					clearDropHl();
				}}
				onDrop={(e) => {
					clearDropHl();
					if (!isFileDrag(e)) return;
					e.preventDefault();
					e.stopPropagation();
					clearAppDrop();
					const files = Array.from(e.dataTransfer?.files ?? []);
					if (files.length === 0) {
						onNotice("warning", t("foldersNotSupported"));
						return;
					}
					uploadFilesTo(dropDirFor(e.target), files);
				}}
				onDragEnd={clearDropHl}
			>
				<input ref={fileInput} type="file" multiple hidden onChange={uploadPicked} />
				{loading && <div className="panel-empty">{t("loading")}</div>}
				{!loading && files && files.path === currentPath && (
					<>
						{files.parent != null && (
							<button type="button" className="file-item dir" onClick={goUp}>
								<FiFolder className="file-icon" />
								<span className="file-name">..</span>
							</button>
						)}
						{files.entries.map((e) =>
							e.type === "dir" ? (
								<div
									key={e.path}
									className="file-item dir"
									data-type="dir"
									data-path={e.path}
									onContextMenu={(ev) => {
										// 拦截冒泡：否则 panel-body 的处理器后执行，把目标覆盖成当前目录
										ev.stopPropagation();
										const projectPath = toProjectPath(e.path);
										openCtxMenu(ev, e.path, projectPath ? { path: projectPath, name: e.name } : null);
									}}
								>
									<button type="button" className="file-dir-main" onClick={() => openDir(e.path)}>
										<FiFolder className="file-icon" />
										<span className="file-name">{e.name}</span>
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip={t("linkFolderTip")}
										aria-label={t("linkFolderTip")}
										onClick={() => onAttach(e.path, e.name, "reference", true)}
									>
										<FiLink />
									</button>
									<button
										type="button"
										className={`file-attach copy${copiedKey === `name:${e.path}` ? " copied" : ""}`}
										data-tip={t("copyName")}
										aria-label={t("copyName")}
										onClick={() => copyText(e.name, `name:${e.path}`)}
									>
										{copiedKey === `name:${e.path}` ? <FiCheck /> : <FiCopy />}
									</button>
									<button
										type="button"
										className={`file-attach copy${copiedKey === `path:${e.path}` ? " copied" : ""}`}
										data-tip={t("copyPath")}
										aria-label={t("copyPath")}
										onClick={() => copyText(absPathOf(e.path), `path:${e.path}`)}
									>
										{copiedKey === `path:${e.path}` ? <FiCheck /> : <FiClipboard />}
									</button>
								</div>
							) : (
								<div
									key={e.path}
									className="file-item file"
									data-type="file"
									data-path={e.path}
									onContextMenu={(ev) => {
										ev.stopPropagation();
										openCtxMenu(ev, currentPath);
									}}
								>
									<button
										type="button"
										className="file-name"
										title={`${e.path} — ${t("previewFile")}`}
										onClick={() => onPreview(e.path, e.name)}
									>
										<FiFile className="file-icon" />
										<span className="file-name-text">{e.name}</span>
									</button>
									{/* Download: any file, previewable or not (binary/archives
									too). Fetched as a blob so Safe Browsing can't block the
									HTTP download and failures show a readable error. */}
									<button
										type="button"
										className="file-attach download"
										data-tip={t("downloadFile")}
										onClick={() => {
											void downloadFile(e.path, e.name).then((r) => {
												if (r.ok) return;
												// cancelled: user dismissed the save dialog — not an error.
												if (r.cancelled) return;
												onNotice(
													"error",
													t("downloadFailed", {
														error: r.error === DOWNLOAD_FILE_NOT_FOUND ? t("fileNotFoundShort") : r.error,
													}),
												);
											});
										}}
									>
										<FiDownload />
									</button>
									<button
										type="button"
										className="file-attach inline"
										data-tip={t("attachInlineTip")}
										onClick={() => onAttach(e.path, e.name, "inline")}
									>
										<FiPlus />
									</button>
									<button
										type="button"
										className="file-attach ref"
										data-tip={t("referenceTip")}
										aria-label={t("referenceTip")}
										onClick={() => onAttach(e.path, e.name, "reference")}
									>
										<FiLink />
									</button>
									<button
										type="button"
										className={`file-attach copy${copiedKey === `name:${e.path}` ? " copied" : ""}`}
										data-tip={t("copyName")}
										aria-label={t("copyName")}
										onClick={() => copyText(e.name, `name:${e.path}`)}
									>
										{copiedKey === `name:${e.path}` ? <FiCheck /> : <FiCopy />}
									</button>
									<button
										type="button"
										className={`file-attach copy${copiedKey === `path:${e.path}` ? " copied" : ""}`}
										data-tip={t("copyPath")}
										aria-label={t("copyPath")}
										onClick={() => copyText(absPathOf(e.path), `path:${e.path}`)}
									>
										{copiedKey === `path:${e.path}` ? <FiCheck /> : <FiClipboard />}
									</button>
								</div>
							),
						)}
						{files.truncated && <div className="panel-empty files-truncated">{t("filesTruncated")}</div>}
					</>
				)}
				{!loading && !files && <div className="panel-empty">{t("noFiles")}</div>}
			</div>
			{hasWidgets && (
				<div
					className="rp-sash"
					onPointerDown={onSashDown}
					onDoubleClick={() => setRpWeights({ ...DEFAULT_RP_WEIGHTS })}
					title={t("dragToResize")}
				/>
			)}
			{hasWidgets && (
				<div className="panel-widgets" style={{ flexGrow: rpWeights.widgets, minHeight: RP_MIN_WIDGETS_PX }}>
					{widgets
						.filter((w) => w.lines.length > 0)
						.map((w) => (
							<div key={w.key} className="widget">
								<button
									type="button"
									className="widget-title widget-title-btn"
									title={t("widgetExpand")}
									onClick={() => setExpandedWidget(w.key)}
								>
									<span>{w.key}</span>
									<FiMaximize2 />
								</button>
								<pre className="widget-lines">{w.lines.join("\n")}</pre>
							</div>
						))}
				</div>
			)}
			{expandedWidget &&
				(() => {
					const w = widgets.find((x) => x.key === expandedWidget);
					if (!w) return null;
					return (
						<div className="modal-backdrop" onClick={() => setExpandedWidget(null)}>
							<div className="widget-expand" onClick={(e) => e.stopPropagation()}>
								<div className="widget-expand-head">
									<span className="widget-expand-title">{w.key}</span>
									<button type="button" className="btn" title={t("close")} onClick={() => setExpandedWidget(null)}>
										<FiX />
									</button>
								</div>
								<pre className="widget-expand-lines">{w.lines.join("\n")}</pre>
							</div>
						</div>
					);
				})()}
			{/* Right-click context menu: upload files into the target folder. */}
			{ctxMenu && (
				<div
					className="ctx-menu"
					style={{ left: ctxMenu.x, top: ctxMenu.y }}
					onContextMenu={(e) => {
						// Keep the menu up on a second right-click so users can re-pick.
						e.preventDefault();
						e.stopPropagation();
					}}
				>
					<button type="button" className="ctx-item" onClick={pickFiles}>
						<FiUpload />
						{ctxDir.current === currentPath ? t("uploadToCurrentDir") : t("uploadToFolder")}
					</button>
					{ctxProject.current && (
						<button type="button" className="ctx-item" onClick={openAsProject}>
							<FiFolder />
							{t("openAsProject")}
						</button>
					)}
				</div>
			)}
		</aside>
	);
});
