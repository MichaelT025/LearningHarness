import { RoleIcon } from "./RoleIcon";

/** Worker role label with the role's glyph in the role's hue (see
 *  --agent-* in styles.css). The text carries the role; the colour and icon
 *  are hints, never the only signal. Shared by the delegate tool card and
 *  the Workers pane (its own file keeps ToolCallBlock ⇄ WorkersPanel from
 *  importing each other). */
export function RoleChip({ role }: { role: string }) {
	return (
		<span className="worker-role" data-role={role}>
			<RoleIcon role={role} className="worker-role-icon" />
			{role || "worker"}
		</span>
	);
}
