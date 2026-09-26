/**
 * Dispatch agent roles — client-side constants and parsing helpers.
 *
 * The AUTHORITATIVE active role comes from the Dispatch extension's status
 * bridge: its `select()` ends with `ctx.ui.setStatus("piastra-agent",
 * "Agent: <role>")`, which the server bridges to the browser as a `statuses`
 * message (see server/webui-context.ts). We parse that status here and NEVER
 * infer the role from the active model id — a role switch also changes model /
 * thinking / tools, but model id alone is not a role signal.
 *
 * Extension presence is detected from the slash-command catalog the server
 * pushes: the extension registers `/agent` and `/dispatch` (`/piastra` is a
 * retained alias for older extension versions). Absent → the UI
 * shows a neutral fallback and must not send a role command (which the SDK
 * would otherwise treat as a plain prompt — model-prompt masquerading).
 *
 * The catalog is NOT extension-only: it also contains prompt templates
 * (source "prompt"), skills ("skill"), UI plugins ("plugin") and web builtins
 * ("builtin"). A template/plugin may coincidentally be named "agent",
 * "dispatch", or "piastra", so presence must require the role-selection name
 * AND a summary name with source === "extension"
 * (see SlashCommandInfo in server/protocol.ts) — otherwise a colliding
 * non-extension command would wrongly switch the UI into role mode and let the
 * picker send `/agent <role>` as a plain prompt to the model.
 */

export const AGENT_ROLES = ["orchestrator", "general", "fast", "review"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Footer-status key the Dispatch extension uses (`setStatus` bridge).
 * LEGACY: the key stays `piastra-agent` for compatibility with installed
 * extension versions and saved client state.
 */
export const AGENT_STATUS_KEY = "piastra-agent";

/** The extension emits exactly `Agent: <role>` (see extensions/piastra/agents.mjs). */
const AGENT_STATUS_RE = /^Agent:\s*([A-Za-z0-9_-]+)\s*$/i;

export function isAgentRole(value: unknown): value is AgentRole {
	return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

/**
 * Parse the confirmed active role from the server-pushed status entries.
 * Returns null when the status is absent/malformed — callers treat null as
 * "role unknown" and do NOT fall back to the active model.
 */
export function parseAgentRole(
	statuses: { key: string; text: string | undefined }[] | null | undefined,
): AgentRole | null {
	if (!statuses || statuses.length === 0) return null;
	const entry = statuses.find((s) => s.key === AGENT_STATUS_KEY);
	if (!entry?.text) return null;
	const match = AGENT_STATUS_RE.exec(entry.text.trim());
	if (!match) return null;
	const role = match[1].toLowerCase();
	return isAgentRole(role) ? role : null;
}

/**
 * True only when the Dispatch extension is loaded: it registers `/agent` (role
 * selection) AND `/dispatch` (role summary; legacy `/piastra` accepted as an
 * alias for older extension versions), both as SDK extension commands
 * (source === "extension"). Requiring both names guards against a catalog that
 * merely happens to carry one of them (e.g. a prompt template or UI plugin
 * named "agent"), and requiring the extension source rejects same-named
 * templates/plugins/skills/builtins so the picker never sends
 * `/agent <role>` as a plain prompt.
 */
export function hasDispatchExtension(slashCommands: { name: string; source?: string }[] | null | undefined): boolean {
	if (!slashCommands || slashCommands.length === 0) return false;
	const hasAgent = slashCommands.some((c) => c.name === "agent" && c.source === "extension");
	const hasSummary = slashCommands.some(
		(c) => (c.name === "dispatch" || c.name === "piastra") && c.source === "extension",
	);
	return hasAgent && hasSummary;
}

/**
 * Compatibility alias — prefer {@link hasDispatchExtension} in new code.
 * Accepts the same catalogs (including legacy `/piastra` summary commands).
 */
export const hasPiastraExtension = hasDispatchExtension;
