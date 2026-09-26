import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 「？」悬浮提示（共享组件）：长解释默认不占版面，hover / 键盘聚焦时浮出全文。
 *
 * 顶层渲染：portal 到 document.body + fixed 定位，不受滚动容器 overflow 裁剪
 * （以前是 absolute 下挂在行内，贴底部的行气泡会被 modal-body 裁掉看不见）。
 * 打开后实测气泡尺寸：右侧/下侧空间不足自动翻转（左展/上展），四边钳制在视口内。
 * 滚动/缩放/Esc/失焦即收起（fixed 跟不住滚动的锚点）。
 */
export function HintTip({ text }: { text: string }) {
	const anchorRef = useRef<HTMLSpanElement>(null);
	const bubbleRef = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState({ left: 0, top: 0 });

	const show = () => {
		const r = anchorRef.current?.getBoundingClientRect();
		if (!r) return;
		// 先按向下展开摆位，实测尺寸后再翻转（见下 effect；文本长度不定估算不可靠）。
		setPos({ left: Math.max(8, r.left - 8), top: r.bottom + 8 });
		setOpen(true);
	};
	const hide = () => setOpen(false);

	// 打开后实测气泡尺寸再翻转/钳制。
	useEffect(() => {
		if (!open) return;
		const b = bubbleRef.current;
		const a = anchorRef.current;
		if (!b || !a) return;
		const r = b.getBoundingClientRect();
		const ar = a.getBoundingClientRect();
		let left = ar.left - 8;
		let top = ar.bottom + 8;
		if (left + r.width > window.innerWidth - 8) left = Math.max(8, ar.right + 8 - r.width);
		if (top + r.height > window.innerHeight - 8) top = Math.max(8, ar.top - 8 - r.height);
		setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
	}, [open, text]);

	// 锚点滚动/窗口缩放后位置即失效，直接收起；Esc 失焦同理。
	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	return (
		<span
			ref={anchorRef}
			className="set-tip"
			tabIndex={0}
			aria-label={text}
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
			onKeyDown={(e) => {
				if (e.key === "Escape") (e.target as HTMLElement).blur();
			}}
		>
			?
			{open &&
				createPortal(
					<span
						ref={bubbleRef}
						className="set-tip-bubble open"
						role="tooltip"
						style={{ position: "fixed", left: pos.left, top: pos.top }}
					>
						{text}
					</span>,
					document.body,
				)}
		</span>
	);
}
