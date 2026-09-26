import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useT } from "../i18n";

const PITCH = 7;
const OVERSCAN = 8;
const IDLE_WIDTH = 16;
const ACTIVE_WIDTH = 24;

export interface PromptMinimapQuestion {
	id: string;
	text: string;
}

export interface PromptMinimapProps {
	questions: PromptMinimapQuestion[];
	activeIndex: number;
	onJump: (id: string) => void;
}

function bounded(index: number, count: number): number {
	return Math.max(0, Math.min(count - 1, index));
}

/** A compact, virtualized prompt navigator. The message list owns navigation
 * semantics (including lazy mounting); this component only presents a bounded
 * set of prompt ticks and reports the selected id. */
export function PromptMinimap({ questions, activeIndex, onJump }: PromptMinimapProps) {
	const t = useT();
	const railRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const previousQuestionsRef = useRef<PromptMinimapQuestion[] | null>(null);
	const [viewportHeight, setViewportHeight] = useState(0);
	const [transcriptHeight, setTranscriptHeight] = useState(0);
	const [resizeVersion, setResizeVersion] = useState(0);
	const [sessionResetVersion, setSessionResetVersion] = useState(0);
	const [scrollTop, setScrollTop] = useState(0);
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);
	const [focusRequest, setFocusRequest] = useState<number | null>(null);
	const [interactionReleaseVersion, setInteractionReleaseVersion] = useState(0);

	const count = questions.length;
	const questionSignature = questions.map((question) => `${question.id}\u0000${question.text}`).join("\u0001");
	const effectiveHeight = viewportHeight || 300;
	const visibleCount = Math.ceil(effectiveHeight / PITCH) + OVERSCAN * 2;
	const start = Math.max(0, Math.floor(scrollTop / PITCH) - OVERSCAN);
	const end = Math.min(count, start + visibleCount);
	const visibleQuestions = useMemo(() => questions.slice(start, end), [questions, start, end]);
	const interactionIndex = hoveredIndex ?? focusedIndex ?? (activeIndex >= 0 ? activeIndex : null);
	const previewOwner = hoveredIndex ?? focusedIndex;

	// Hover takes precedence over focus, but leaving a hovered tick restores the
	// focused tick's preview. This effect owns the delay so every owner change
	// cancels the old timer and starts a fresh one.
	useEffect(() => {
		if (tooltipTimerRef.current) {
			clearTimeout(tooltipTimerRef.current);
			tooltipTimerRef.current = null;
		}
		setPreviewIndex(null);
		if (previewOwner === null) return;
		const owner = previewOwner;
		tooltipTimerRef.current = setTimeout(() => {
			tooltipTimerRef.current = null;
			setPreviewIndex(owner);
		}, 200);
		return () => {
			if (tooltipTimerRef.current) {
				clearTimeout(tooltipTimerRef.current);
				tooltipTimerRef.current = null;
			}
		};
	}, [previewOwner]);

	const reveal = useCallback(
		(index: number, behavior: ScrollBehavior = "auto") => {
			const viewport = viewportRef.current;
			if (!viewport || index < 0 || index >= count) return;
			const top = index * PITCH;
			const bottom = top + PITCH;
			const viewTop = viewport.scrollTop;
			const viewBottom = viewTop + viewport.clientHeight;
			const setTop = (nextTop: number) => {
				if (typeof viewport.scrollTo === "function") viewport.scrollTo({ top: nextTop, behavior });
				else viewport.scrollTop = nextTop;
				setScrollTop(nextTop);
			};
			if (top < viewTop) setTop(top);
			else if (bottom > viewBottom) setTop(bottom - viewport.clientHeight);
		},
		[count],
	);

	// Depend on count because the first render can be empty: an effect with []
	// would miss the viewport created by the first question. Measuring the
	// transcript, rather than 50vh, accounts for composer/terminal shrinkage.
	useEffect(() => {
		const viewport = viewportRef.current;
		const rail = railRef.current;
		if (!viewport || !rail) return;
		const parent = rail.parentElement;
		const transcript =
			parent && (parent.matches(".messages") ? parent : parent.querySelector<HTMLElement>(".messages"));
		const update = () => {
			setViewportHeight(viewport.clientHeight);
			setTranscriptHeight(transcript?.clientHeight ?? parent?.clientHeight ?? 0);
			setResizeVersion((version) => version + 1);
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(viewport);
		if (transcript) observer.observe(transcript);
		return () => observer.disconnect();
	}, [count]);

	// Session changes clear interaction and scroll state. A pure append keeps
	// those states intact, so streaming prompts do not yank the rail to top.
	useEffect(() => {
		const previous = previousQuestionsRef.current;
		previousQuestionsRef.current = questions;
		const isAppend =
			previous !== null &&
			questions.length > previous.length &&
			previous.every((question, index) => {
				const next = questions[index];
				return next?.id === question.id && next.text === question.text;
			});
		if (isAppend) return;
		setHoveredIndex(null);
		setFocusedIndex(null);
		setFocusRequest(null);
		setScrollTop(0);
		setSessionResetVersion((version) => version + 1);
		if (viewportRef.current) viewportRef.current.scrollTop = 0;
	}, [questionSignature]);

	// Virtual scrolling can remove a focused or hovered button without dispatching
	// blur/pointerleave. Reconcile ownership from the rendered window instead of
	// trying to restore focus (which would fight wheel scrolling). A pending
	// keyboard request is intentionally left alone until its destination mounts.
	useEffect(() => {
		if (focusRequest !== null) return;
		const isRendered = (index: number) => index >= start && index < end;
		const activeElement = viewportRef.current?.ownerDocument.activeElement;
		const actualFocusedButton =
			activeElement instanceof HTMLButtonElement && activeElement.closest(".qn-rail-viewport") === viewportRef.current
				? activeElement
				: null;
		const focusedIsStale =
			focusedIndex !== null &&
			(!isRendered(focusedIndex) || Number(actualFocusedButton?.dataset.qnIndex) !== focusedIndex);
		const hoveredIsStale = hoveredIndex !== null && !isRendered(hoveredIndex);
		if (focusedIsStale) setFocusedIndex(null);
		if (hoveredIsStale) setHoveredIndex(null);
	}, [end, focusRequest, focusedIndex, hoveredIndex, start]);

	// The active marker follows the transcript, but a reader's hover/focus owns
	// the rail until they leave it. Stale virtualized ownership is cleared above
	// without incrementing this release version, so wheel scrolling is not
	// immediately undone by autoreveal. Explicit leave/blur still restores it.
	useEffect(() => {
		if (hoveredIndex !== null || focusedIndex !== null) return;
		if (activeIndex >= 0) reveal(activeIndex);
	}, [activeIndex, interactionReleaseVersion, reveal, resizeVersion, sessionResetVersion]);

	useEffect(() => {
		if (focusRequest === null) return;
		const button = viewportRef.current?.querySelector<HTMLButtonElement>(`[data-qn-index="${focusRequest}"]`);
		if (button) {
			button.focus();
			setFocusRequest(null);
		}
	}, [focusRequest, start, end]);

	if (count === 0) return null;

	const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
		let next: number | null = null;
		if (event.key === "ArrowUp") next = bounded(index - 1, count);
		else if (event.key === "ArrowDown") next = bounded(index + 1, count);
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = count - 1;
		if (next === null) return; // Enter remains the button's native click.
		event.preventDefault();
		setFocusedIndex(next);
		reveal(next, "smooth");
		setFocusRequest(next);
	};

	const previewQuestion = previewIndex === null ? null : questions[previewIndex];
	const tooltipHeight = 38;
	const tooltipTop =
		previewIndex === null
			? 0
			: Math.max(4, Math.min(Math.max(4, effectiveHeight - tooltipHeight - 4), previewIndex * PITCH - scrollTop - 15));
	const railCap = transcriptHeight > 0 ? transcriptHeight / 2 : PITCH;
	const railHeight = `${Math.min(Math.max(PITCH, count * PITCH), Math.max(PITCH, railCap))}px`;

	return (
		<div ref={railRef} className="qn-rail" aria-label={t("questionNavTitle")}>
			<div
				className="qn-rail-viewport"
				ref={viewportRef}
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				onMouseLeave={() => {
					if (hoveredIndex !== null) setInteractionReleaseVersion((version) => version + 1);
					setHoveredIndex(null);
				}}
				style={{ height: railHeight }}
			>
				<div className="qn-rail-track" style={{ height: `${count * PITCH}px` }}>
					{visibleQuestions.map((question, offset) => {
						const index = start + offset;
						const distance = interactionIndex === null ? Infinity : Math.abs(index - interactionIndex);
						const width =
							index === activeIndex || index === hoveredIndex || index === focusedIndex || distance === 0
								? ACTIVE_WIDTH
								: distance === 1
									? 22
									: distance === 2
										? 20
										: distance === 3
											? 18
											: IDLE_WIDTH;
						return (
							<button
								type="button"
								key={question.id}
								className={`qn-bar ${index === activeIndex ? "active" : ""}`}
								data-qn-index={index}
								aria-label={`${index + 1}. ${question.text}`}
								aria-current={index === activeIndex ? "location" : undefined}
								style={{ top: `${index * PITCH}px`, width: "24px", "--tick-width": `${width}px` } as CSSProperties}
								onClick={() => onJump(question.id)}
								onPointerEnter={() => setHoveredIndex(index)}
								onPointerLeave={() => {
									if (hoveredIndex === index) setInteractionReleaseVersion((version) => version + 1);
									setHoveredIndex((current) => (current === index ? null : current));
								}}
								onFocus={() => setFocusedIndex(index)}
								onBlur={() => {
									if (focusedIndex === index) setInteractionReleaseVersion((version) => version + 1);
									setFocusedIndex((current) => (current === index ? null : current));
								}}
								onKeyDown={(event) => onKeyDown(event, index)}
							></button>
						);
					})}
				</div>
			</div>
			{previewQuestion && (
				<div className="qn-tooltip" role="tooltip" style={{ top: `${tooltipTop}px` }}>
					{previewQuestion.text}
				</div>
			)}
		</div>
	);
}
