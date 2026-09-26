import { memo, useEffect, useRef, useState } from "react";
import { FiChevronDown, FiTarget } from "react-icons/fi";
import { RoleIcon } from "./RoleIcon";
import { AGENT_ROLES, type AgentRole } from "../agents";
import { useT } from "../i18n";

/** i18n key per role — resolved through `t` so the picker stays localized. */
const ROLE_LABEL_KEY = {
	orchestrator: "agentRoleOrchestrator",
	general: "agentRoleGeneral",
	fast: "agentRoleFast",
	review: "agentRoleReview",
} as const;

interface AgentPickerProps {
	/** Confirmed active role from the server status bridge (null = unknown —
	 *  we render no pressed button rather than an optimistic false label). */
	activeRole: AgentRole | null;
	/** Whether the Dispatch extension is loaded (/agent + /dispatch, legacy /piastra alias). */
	available: boolean;
	/** Busy (agent streaming) → buttons disabled with an explanation. */
	busy: boolean;
	onSelect: (role: AgentRole) => void;
}

/**
 * Compact role pill shown at the left of the composer tool row. The pill
 * names the server-confirmed role; opening it reveals the four role buttons
 * (always in the DOM so tests and assistive tech can address them). It is
 * purely a client-side selector over the EXISTING `/agent <role>` slash-
 * command transport: selecting a role sends that command to the server, the
 * extension performs the real switch (model + thinking + tools + `setStatus`),
 * and the pressed state follows the confirmed server status — never an
 * optimistic local guess.
 */
export const AgentPicker = memo(function AgentPicker({ activeRole, available, busy, onSelect }: AgentPickerProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	// Click-outside / Escape close (same contract as Dropdown).
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Neutral fallback when the extension is absent: a single muted, non-
	// interactive badge. No role is claimed and no /agent prompt is sent.
	if (!available) {
		return (
			<div className="agent-picker agent-picker-unavailable" role="status" title={t("agentPickerUnavailable")}>
				<FiTarget aria-hidden="true" />
				<span>{t("agentPickerNeutral")}</span>
			</div>
		);
	}

	const disabled = busy;
	const reason = busy ? t("agentPickerBusy") : undefined;
	const pillLabel = activeRole ? t(ROLE_LABEL_KEY[activeRole]) : t("agentPickerNeutral");

	return (
		<div className={`agent-picker${open ? " open" : ""}`} ref={ref}>
			<button
				type="button"
				className="agent-picker-pill"
				data-agent-active={activeRole ?? ""}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t("agentPickerLabel")}
				title={reason ?? t("agentPickerLabel")}
				onClick={() => setOpen((v) => !v)}
			>
				<RoleIcon role={activeRole} />
				<span className="agent-picker-pill-label">{pillLabel}</span>
				<FiChevronDown className={`dd-caret${open ? " up" : ""}`} aria-hidden="true" />
			</button>
			<div className="agent-picker-menu" role="group" aria-label={t("agentPickerLabel")}>
				{AGENT_ROLES.map((role) => {
					const active = activeRole === role;
					return (
						<button
							key={role}
							type="button"
							className={`agent-picker-btn${active ? " active" : ""}`}
							data-agent-role={role}
							aria-pressed={active}
							disabled={disabled}
							title={reason ?? t(ROLE_LABEL_KEY[role])}
							onClick={() => {
								onSelect(role);
								setOpen(false);
							}}
						>
							<RoleIcon role={role} className="agent-picker-btn-icon" />
							{t(ROLE_LABEL_KEY[role])}
						</button>
					);
				})}
			</div>
			{/* Accessible, text-based active label — color/highlight is never the
			    sole signal. Also doubles as the busy explanation (live region). */}
			<span className="agent-picker-active" role="status">
				{busy
					? t("agentPickerBusy")
					: activeRole
						? t("agentActiveRole", { role: t(ROLE_LABEL_KEY[activeRole]) })
						: t("agentUnknown")}
			</span>
		</div>
	);
});
