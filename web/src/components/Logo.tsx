import { memo } from "react";
import mark from "../assets/dispatch-mark.svg?raw";

interface LogoProps {
	/** Rendered box size in px (the mark is square). */
	size?: number;
	className?: string;
}

/**
 * Supplied Dispatch artwork, inlined so it follows `currentColor`
 * (light on the dark shell, dark on light themes) while the red
 * core keeps its fixed hue (#fc0b12).
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
