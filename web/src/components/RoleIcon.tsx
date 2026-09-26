import type { ComponentType } from "react";
import { FiCompass, FiEye, FiTarget, FiTool, FiZap } from "react-icons/fi";

/** One glyph per Dispatch role, hinting at what the role does: the
 *  orchestrator steers (compass), general builds (tool), fast is quick
 *  research/edits (bolt), review inspects (eye). Unknown roles get the
 *  neutral target the picker always used. The hue comes from CSS
 *  (--agent-* tokens) via the surrounding element, never from here. */
const ROLE_ICONS: Record<string, ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
	orchestrator: FiCompass,
	general: FiTool,
	fast: FiZap,
	review: FiEye,
};

export function RoleIcon({ role, className }: { role: string | null | undefined; className?: string }) {
	const Icon = (role && ROLE_ICONS[role]) || FiTarget;
	return <Icon className={className} aria-hidden="true" />;
}
