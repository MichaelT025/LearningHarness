/**
 * tool-manager.ts — single source of truth for the agent tool switches.
 *
 * Only the ActiveSet layer lives here (SDK customTools toggled through
 * getActiveToolNames/setActiveToolsByName — live, no reload). Skills and
 * extensions are resource filters with their own lifecycle and stay out.
 *
 * Persisted state is just `ClientSettings.disabledAgentTools: string[]`; the
 * older `terminalToolsEnabled` / `questionnaireEnabled` booleans survive as
 * protocol-compatible aliases synced by the legacy* helpers below.
 *
 * Pure module: no node imports, so the web bundle can import it too.
 */

/** Persistent-terminal tools (defined in terminals.ts). */
export const TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

/** Questionnaire tool (defined in agent-service.ts makeAskUserQuestionTool). */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export type AgentToolGroup = "terminal" | "other";

export interface AgentToolEntry {
	name: string;
	group: AgentToolGroup;
	/** Default state (terminal group off, the rest on). */
	defaultOn: boolean;
}

/** Every switchable agent tool. bash and the SDK's built-in edit/read are
 *  deliberately absent — the agent is useless without them. */
export const AGENT_TOOL_CATALOG: AgentToolEntry[] = [
	...TERMINAL_TOOL_NAMES.map((name): AgentToolEntry => ({ name, group: "terminal", defaultOn: false })),
	{ name: ASK_USER_QUESTION_TOOL_NAME, group: "other", defaultOn: true },
];

const KNOWN_NAMES = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));

export function isKnownAgentTool(name: string): boolean {
	return KNOWN_NAMES.has(name);
}

/** Normalise a disabled list: non-arrays fall back to the defaults; arrays
 *  keep only known names (deduped — unknown names from old files are dropped). */
export function normalizeDisabledAgentTools(v: unknown): string[] {
	if (!Array.isArray(v)) return defaultDisabledAgentTools();
	const out: string[] = [];
	for (const name of v) {
		if (typeof name === "string" && KNOWN_NAMES.has(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

export function defaultDisabledAgentTools(): string[] {
	return AGENT_TOOL_CATALOG.filter((t) => !t.defaultOn).map((t) => t.name);
}

export function isAgentToolEnabled(name: string, disabled: readonly string[]): boolean {
	return !disabled.includes(name);
}

/** ActiveSet subset of the SDK AgentSession (structural so tests can fake it). */
export interface ActiveToolSet {
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
}

/** Toggle one registered tool live. Unknown names / unready session → false. */
export function setAgentToolEnabled(session: ActiveToolSet, name: string, on: boolean): boolean {
	if (!isKnownAgentTool(name)) return false;
	try {
		const names = new Set(session.getActiveToolNames());
		if (on) names.add(name);
		else names.delete(name);
		session.setActiveToolsByName([...names]);
		return true;
	} catch {
		return false;
	}
}

/** Batch toggle; unknown names are skipped. Returns the number handled. */
export function setAgentToolsEnabled(session: ActiveToolSet, names: readonly string[], on: boolean): number {
	const known = names.filter(isKnownAgentTool);
	if (known.length === 0) return 0;
	try {
		const active = new Set(session.getActiveToolNames());
		for (const n of known) {
			if (on) active.add(n);
			else active.delete(n);
		}
		session.setActiveToolsByName([...active]);
		return known.length;
	} catch {
		return 0;
	}
}

/**
 * Full replay (session creation / after reload / after a settings change):
 * add or remove every catalog tool by the disabled list; tools outside the
 * catalog (bash, SDK built-ins, extension tools) are left untouched.
 */
export function applyAgentToolsGating(session: ActiveToolSet, disabled: readonly string[]): void {
	try {
		const off = new Set(disabled);
		const names = new Set(session.getActiveToolNames());
		for (const t of AGENT_TOOL_CATALOG) {
			if (off.has(t.name)) names.delete(t.name);
			else names.add(t.name);
		}
		session.setActiveToolsByName([...names]);
	} catch {
		// Session not ready — the next create/reload applies it.
	}
}

// ---------------------------------------------------------------------------
// Legacy alias sync (terminalToolsEnabled / questionnaireEnabled)
// ---------------------------------------------------------------------------

export interface LegacyToolSwitches {
	terminalToolsEnabled?: boolean;
	questionnaireEnabled?: boolean;
	disabledAgentTools?: unknown;
}

/** Old-file migration: use the new field when present, else fold the booleans. */
export function legacyToDisabled(s: LegacyToolSwitches): string[] {
	if (Array.isArray(s.disabledAgentTools)) return normalizeDisabledAgentTools(s.disabledAgentTools);
	const off: string[] = [];
	if (s.terminalToolsEnabled !== true) off.push(...TERMINAL_TOOL_NAMES);
	if (s.questionnaireEnabled === false) off.push(ASK_USER_QUESTION_TOOL_NAME);
	return normalizeDisabledAgentTools(off);
}

/** Derive the legacy booleans (terminal group counts as on only when all are on). */
export function deriveLegacy(disabled: readonly string[]): {
	terminalToolsEnabled: boolean;
	questionnaireEnabled: boolean;
} {
	const off = new Set(disabled);
	return {
		terminalToolsEnabled: TERMINAL_TOOL_NAMES.every((n) => !off.has(n)),
		questionnaireEnabled: !off.has(ASK_USER_QUESTION_TOOL_NAME),
	};
}

/** Fold a legacy boolean write into the disabled list (undefined = untouched). */
export function foldLegacyIntoDisabled(
	current: readonly string[],
	legacy: Pick<LegacyToolSwitches, "terminalToolsEnabled" | "questionnaireEnabled">,
): string[] {
	const next = new Set(normalizeDisabledAgentTools(current));
	const applyGroup = (names: readonly string[], v: boolean | undefined) => {
		if (v === undefined) return;
		for (const n of names) {
			if (v) next.delete(n);
			else next.add(n);
		}
	};
	applyGroup(TERMINAL_TOOL_NAMES, legacy.terminalToolsEnabled);
	applyGroup([ASK_USER_QUESTION_TOOL_NAME], legacy.questionnaireEnabled);
	return [...next];
}

/** Effective gating list: new field merged with the questionnaire alias. */
export function effectiveDisabledAgentTools(s: LegacyToolSwitches): string[] {
	const next = new Set(legacyToDisabled(s));
	if (s.questionnaireEnabled === false) next.add(ASK_USER_QUESTION_TOOL_NAME);
	return [...next];
}

/** Whether the terminal usage guidance is injected (only when some terminal tool is on). */
export function isTerminalGuidanceOn(disabled: readonly string[]): boolean {
	return TERMINAL_TOOL_NAMES.some((n) => !disabled.includes(n));
}
