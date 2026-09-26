import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { Markdown } from "./Markdown";

interface QuestionDialogProps {
	question: {
		id: string;
		/** 服务端超时时间戳（epoch ms）——显示倒计时，归零自动取消。 */
		deadline?: number;
		questions: {
			id: string;
			question: string;
			detail?: string;
			header?: string;
			options?: { label: string; description?: string; preview?: string }[];
			multiSelect?: boolean;
		}[];
	};
}

/**
 * Model question dialog (ask_user_question tool → question_pending notice).
 * 向导式：每次只显示一道题。
 *  - 单选：点选项即选中并自动进入下一题；最后一题点选项直接提交。
 *  - 多选/自由文本：勾选或输入后用「下一步/提交」推进，「上一步」可回头修改。
 *  - ✗ / Esc / 底部「取消」→ 取消提问；提交与取消都会立即收起本面板
 *    （use-chat 在发出 question_answer 后置空 question）。
 * 选中带 `preview` 的选项时在下方预览其 markdown/HTML 内容。
 * 复用 .dialog-inline 样式（非模态，对话保持可见）。
 *
 * 文本渲染：question/detail/description/preview 统一走 Markdown（rawHtml），
 * 模型可自由写 markdown 或 HTML —— 由模型自选、信任模型。
 */
export function QuestionDialog({ question }: QuestionDialogProps) {
	const t = useT();
	const [selections, setSelections] = useState<Record<string, string[]>>({});
	const [customs, setCustoms] = useState<Record<string, string>>({});
	/** 向导当前步（question.questions 下标），每次新提问从第一题开始。 */
	const [step, setStep] = useState(0);
	// P0-6：倒计时（秒），归零自动取消提问（服务端同样超时 reject）。
	const [remainSec, setRemainSec] = useState<number>(() =>
		question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1,
	);

	useEffect(() => {
		// 每个新提问重置本地状态。
		setSelections({});
		setCustoms({});
		setStep(0);
		setRemainSec(question.deadline ? Math.max(0, Math.ceil((question.deadline - Date.now()) / 1000)) : -1);
	}, [question.id, question.deadline]);

	useEffect(() => {
		if (!question.deadline) return;
		const id = setInterval(() => {
			setRemainSec((s) => {
				const next = Math.max(0, Math.ceil((question.deadline! - Date.now()) / 1000));
				if (next <= 0 && s > 0) {
					// 归零 → 自动取消（服务端超时 reject 模型提问，对话继续）。
					appSend({ type: "question_answer", id: question.id, answers: [], cancelled: true });
				}
				return next;
			});
		}, 1000);
		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question.id, question.deadline]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") cancel();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question.id]);

	const total = question.questions.length;
	const q = question.questions[step];
	if (!q) return null;

	/** 把（可能刚更新、尚未落 state 的）选中结果连同全部题的答案一并提交。 */
	const submitSelections = (sel: Record<string, string[]>) => {
		const answers = question.questions.map((qq) => {
			const selected = sel[qq.id] ?? [];
			const custom = (customs[qq.id] ?? "").trim();
			return { id: qq.id, selected, ...(custom ? { custom } : {}) };
		});
		appSend({ type: "question_answer", id: question.id, answers });
	};

	const cancel = () => {
		appSend({ type: "question_answer", id: question.id, answers: [], cancelled: true });
	};

	const toggleOption = (qid: string, label: string) => {
		setSelections((prev) => {
			const cur = prev[qid] ?? [];
			return {
				...prev,
				[qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
			};
		});
	};

	/** 单选：选中并直接前进；多选：仅切换勾选。 */
	const onOptionClick = (qid: string, label: string, multi: boolean) => {
		if (multi) {
			toggleOption(qid, label);
			return;
		}
		const sel = { ...selections, [qid]: [label] };
		setSelections(sel);
		if (step === total - 1) {
			submitSelections(sel);
		} else {
			setStep(step + 1);
		}
	};

	/** 「下一步/提交」：供多选、自由文本题推进；最后一题提交。 */
	const onNext = () => {
		if (step === total - 1) submitSelections(selections);
		else setStep(step + 1);
	};

	/** 当前题是否可提交：
	 *  - 有选项：须已选中至少一项或填了自定义文本；
	 *  - 无选项（纯自由文本/可跳过）：无需任何输入即可提交，空提交 = 跳过。 */
	const answered = (qid: string) => {
		const qq = question.questions.find((x) => x.id === qid);
		if ((qq?.options?.length ?? 0) === 0) return true;
		return (selections[qid]?.length ?? 0) > 0 || (customs[qid] ?? "").trim() !== "";
	};

	/** 已选中且带 `preview` 的选项预览（当前题；多选选中多个则逐个叠加）。 */
	const previews = (q.options ?? [])
		.filter((o) => (selections[q.id] ?? []).includes(o.label) && o.preview)
		.map((o) => o.preview as string);

	return (
		<div className="dialog-inline" data-dialog-kind="select">
			<div className="dialog-head">
				<span className="dialog-badge">{t("modelQuestion")}</span>
				{total > 1 && <span className="question-progress">{t("questionStep", { cur: step + 1, total })}</span>}
				{remainSec >= 0 && (
					<span className="question-timer">
						{remainSec > 0 ? t("questionTimeout", { s: remainSec }) : t("questionTimeoutExpired")}
					</span>
				)}
				<button type="button" className="dialog-dismiss" title={t("cancel")} onClick={cancel}>
					✕
				</button>
			</div>
			<div className="set-section" key={q.id}>
				<div className="set-section-title">{q.header ?? `${t("modelQuestion")} ${step + 1}`}</div>
				<div className="question-head">
					<Markdown text={q.question} rawHtml />
				</div>
				{q.detail && (
					<div className="set-hint">
						<Markdown text={q.detail} rawHtml />
					</div>
				)}
				{(q.options?.length ?? 0) > 0 && (
					<div className="set-list">
						{q.options!.map((o) => {
							const active = (selections[q.id] ?? []).includes(o.label);
							return (
								<button
									type="button"
									key={o.label}
									className={`set-row question-option${active ? " active" : ""}`}
									onClick={() => onOptionClick(q.id, o.label, !!q.multiSelect)}
								>
									<div className="set-row-name">
										<span className="question-mark">
											{q.multiSelect ? (active ? "☑ " : "☐ ") : active ? "● " : "○ "}
										</span>
										<Markdown text={o.label} rawHtml />
									</div>
									{o.description && (
										<div className="set-row-desc">
											<Markdown text={o.description} rawHtml />
										</div>
									)}
								</button>
							);
						})}
					</div>
				)}
				{previews.length > 0 && (
					<div className="question-preview">
						<div className="question-preview-label">{t("optionPreview")}</div>
						{previews.map((p, i) => (
							<div className="question-preview-body" key={i}>
								<Markdown text={p} rawHtml />
							</div>
						))}
					</div>
				)}
				<input
					className="set-prompt-input question-custom"
					placeholder={t("modelQuestionCustom")}
					value={customs[q.id] ?? ""}
					onChange={(e) => setCustoms((prev) => ({ ...prev, [q.id]: e.target.value }))}
					onKeyDown={(e) => {
						// 回车提交（最后一题提交、否则进入下一题）；未作答则不触发。
						if (e.key === "Enter") {
							e.preventDefault();
							if (answered(q.id)) onNext();
						}
					}}
				/>
			</div>
			<div className="dialog-nav">
				<button type="button" className="dialog-dismiss-inline" onClick={cancel}>
					{t("cancel")}
				</button>
				<div className="dialog-nav-right">
					<button type="button" className="dialog-prev" disabled={step === 0} onClick={() => setStep(step - 1)}>
						{t("previous")}
					</button>
					<button type="button" className="dialog-submit" disabled={!answered(q.id)} onClick={onNext}>
						{step === total - 1 ? t("modelQuestionSubmit") : t("next")}
					</button>
				</div>
			</div>
		</div>
	);
}
