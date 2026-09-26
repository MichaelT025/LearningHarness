import { useState } from "react";
import { thinkingPreviewLine } from "../thinking-preview";
import { shimmerPhase } from "../shimmer";
import { FiCheckCircle, FiChevronDown, FiChevronRight, FiCopy, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：true（开）→ 思考始终完整展开并自动换行
	 *  （流式推理过程也实时可见）；false（关）→ 折叠成一行摘要，流式中一行
	 *  实时显示最新文本。 */
	wrap?: boolean;
	/** 会话内搜索打开时强制展开（折叠内容不在 DOM，搜索索引搜到的词会
	 *  “展开后看不到”）。不改变用户的 open 状态，关闭搜索自动恢复。 */
	forceOpen?: boolean;
	/** Stable key that offsets this label's shimmer from its neighbours'. */
	phaseKey?: string;
}

export function ThinkingBlock({ thinking, streaming, wrap = true, forceOpen = false, phaseKey }: ThinkingBlockProps) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 完整展开；wrap=false（关）→ 折叠。
	// 流式与结束后行为一致——不再出现「流式折叠、结束后又自动展开」的跳动。
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	// 搜索期间 forceOpen 只是“视口展开”，用户 open 状态不受影响
	const shown = expanded || forceOpen;
	// 折叠预览：结束后取开头一行（流式中标签只显示“Thinking”）。
	const preview = thinkingPreviewLine(thinking);
	const [copied, setCopied] = useState(false);
	const copyThinking = () => {
		void navigator.clipboard.writeText(thinking);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	};

	return (
		<div className={`thinking ${shown ? "open" : ""} ${streaming ? "live" : ""}`}>
			<div
				className="chead thinking-head"
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
					className="chead-toggle thinking-toggle"
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
				<span className="chead-icon thinking-icon">
					<FiCpu />
				</span>
				<span
					className={`chead-title thinking-label${streaming ? " shimmer" : ""}`}
					style={streaming ? shimmerPhase(phaseKey ?? "thinking") : undefined}
				>
					{streaming ? t("thinkingNow") : shown ? t("thinking") : t("thinkingPreview", { preview })}
				</span>
				<button
					type="button"
					className="chead-copy toolcall-copy thinking-copy"
					title={copied ? t("copied") : t("copyMessage")}
					aria-label={t("copyMessage")}
					onClick={(e) => {
						e.stopPropagation();
						copyThinking();
					}}
				>
					{copied ? <FiCheckCircle /> : <FiCopy />}
				</button>
			</div>
			{shown && <div className="thinking-body">{thinking}</div>}
		</div>
	);
}
