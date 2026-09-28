/**
 * agents-config — per-role model defaults from config/agents.json (same
 * shape as Dispatch's): `{ "<role>": { "model": "provider/id", "thinking": level | null } }`.
 *
 * Re-read on every use so the file can be edited while the app runs. A role
 * default only seeds a NEW conversation; a resumed transcript keeps its own
 * model, and a model the user picks in the UI wins from then on.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Roles the app knows. More arrive with their features (researcher, grader…). */
export type AgentRole = "tutor";

export interface RoleModel {
	provider: string;
	modelId: string;
	/** Thinking level to set, or undefined to leave the model's default. */
	thinking?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function resolvePkgRoot(): string {
	if (process.env.PI_WEB_PKG_ROOT) return process.env.PI_WEB_PKG_ROOT;
	const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/server or <pkg>/dist/server
	for (const c of [resolve(here, ".."), resolve(here, "..", "..")]) {
		if (existsSync(join(c, "config"))) return c;
	}
	return resolve(here, "..");
}

/** Path of the agents config. */
export function agentsConfigPath(): string {
	return join(resolvePkgRoot(), "config", "agents.json");
}

/** Parse one role entry; undefined when missing or malformed. */
export function parseRoleModel(raw: unknown, role: AgentRole): RoleModel | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const entry = (raw as Record<string, unknown>)[role];
	if (typeof entry !== "object" || entry === null) return undefined;
	const { model, thinking } = entry as { model?: unknown; thinking?: unknown };
	if (typeof model !== "string") return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return undefined;
	return {
		provider: model.slice(0, slash),
		modelId: model.slice(slash + 1),
		thinking: typeof thinking === "string" && THINKING_LEVELS.has(thinking) ? thinking : undefined,
	};
}

/** The configured default for `role`, or undefined (no file, no entry, bad JSON). */
export function roleModel(role: AgentRole, file = agentsConfigPath()): RoleModel | undefined {
	try {
		return parseRoleModel(JSON.parse(readFileSync(file, "utf8")), role);
	} catch {
		return undefined;
	}
}
