import { memo } from "react";
import mark from "../assets/learning-mark.svg?raw";

interface LogoProps {
	/** Rendered box size in px (the mark is square). */
	size?: number;
	className?: string;
}

/**
 * LearningHarness book mark, inlined so it follows `currentColor`
 * in both light and dark themes.
 */
export const Logo = memo(function Logo({ size = 20, className }: LogoProps) {
	return (
		<span
			className={`pi-mark${className ? ` ${className}` : ""}`}
			style={{ width: size, height: size }}
			aria-hidden="true"
			dangerouslySetInnerHTML={{ __html: mark }}
		/>
	);
});
