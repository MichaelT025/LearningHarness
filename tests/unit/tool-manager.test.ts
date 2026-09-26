/**
 * tool-manager unit tests: catalog / normalisation / legacy sync / ActiveSet
 * gating. Zero tokens, zero ports.
 */
import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_CATALOG,
	ASK_USER_QUESTION_TOOL_NAME,
	applyAgentToolsGating,
	defaultDisabledAgentTools,
	deriveLegacy,
	effectiveDisabledAgentTools,
	foldLegacyIntoDisabled,
	isAgentToolEnabled,
	isKnownAgentTool,
	isTerminalGuidanceOn,
	legacyToDisabled,
	normalizeDisabledAgentTools,
	setAgentToolEnabled,
	setAgentToolsEnabled,
	TERMINAL_TOOL_NAMES,
} from "../../server/tool-manager.js";

/** Fake ActiveSet (records the name set only, never touches the SDK). */
function fakeSet(initial: string[] = []) {
	let names = [...initial];
	return {
		getActiveToolNames: () => [...names],
		setActiveToolsByName: (next: string[]) => {
			names = [...next];
		},
		peek: () => names,
	};
}

describe("catalog", () => {
	it("8 switchable tools (7 terminal + ask_user_question)", () => {
		expect(AGENT_TOOL_CATALOG).toHaveLength(8);
		expect(TERMINAL_TOOL_NAMES).toHaveLength(7);
	});

	it("defaults: terminal group off, questionnaire on", () => {
		const off = new Set(defaultDisabledAgentTools());
		for (const n of TERMINAL_TOOL_NAMES) expect(off.has(n)).toBe(true);
		expect(off.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
	});
});

describe("normalize", () => {
	it("non-array falls back to defaults; dirty data keeps known names only (deduped)", () => {
		expect(normalizeDisabledAgentTools(undefined)).toEqual(defaultDisabledAgentTools());
		expect(normalizeDisabledAgentTools(["terminal_read", "nope", "terminal_read", 42])).toEqual(["terminal_read"]);
	});

	it("names of removed tools are dropped", () => {
		expect(normalizeDisabledAgentTools(["subagent_spawn", "edit_soft", "delegate_task", "todo_list"])).toEqual([]);
	});

	it("isKnownAgentTool / isAgentToolEnabled", () => {
		expect(isKnownAgentTool("terminal_create")).toBe(true);
		expect(isKnownAgentTool("bash")).toBe(false);
		expect(isAgentToolEnabled("terminal_read", ["terminal_read"])).toBe(false);
		expect(isAgentToolEnabled("terminal_read", [])).toBe(true);
	});
});

describe("legacy sync", () => {
	it("old files (legacy booleans only) fold with the pre-change semantics", () => {
		// All undefined: terminal off, questionnaire on.
		const d = legacyToDisabled({});
		for (const n of TERMINAL_TOOL_NAMES) expect(d).toContain(n);
		expect(d).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
		// New field wins, legacy values ignored.
		expect(legacyToDisabled({ disabledAgentTools: [], terminalToolsEnabled: false })).toEqual([]);
	});

	it("deriveLegacy (terminal group counts as on only when all are on)", () => {
		expect(deriveLegacy([])).toEqual({ terminalToolsEnabled: true, questionnaireEnabled: true });
		const partial = deriveLegacy([TERMINAL_TOOL_NAMES[0]]);
		expect(partial.terminalToolsEnabled).toBe(false);
		expect(partial.questionnaireEnabled).toBe(true);
	});

	it("foldLegacyIntoDisabled touches only the covered group", () => {
		expect(foldLegacyIntoDisabled([ASK_USER_QUESTION_TOOL_NAME], { terminalToolsEnabled: false })).toEqual([
			ASK_USER_QUESTION_TOOL_NAME,
			...TERMINAL_TOOL_NAMES,
		]);
		// true = remove the group; an omitted group is untouched.
		expect(foldLegacyIntoDisabled([ASK_USER_QUESTION_TOOL_NAME], { questionnaireEnabled: true })).toEqual([]);
		expect(foldLegacyIntoDisabled([ASK_USER_QUESTION_TOOL_NAME], {})).toEqual([ASK_USER_QUESTION_TOOL_NAME]);
	});

	it("effectiveDisabled merges the questionnaire alias", () => {
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [], questionnaireEnabled: false })).toContain(
			ASK_USER_QUESTION_TOOL_NAME,
		);
		expect(effectiveDisabledAgentTools({ disabledAgentTools: [] })).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
	});

	it("terminal guidance is injected only while some terminal tool is on", () => {
		expect(isTerminalGuidanceOn([])).toBe(true);
		expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES])).toBe(false);
		expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(true);
	});
});

describe("tool_manage entry points", () => {
	it("setAgentToolEnabled toggles one tool; unknown names / unready session → false", () => {
		const s = fakeSet(["terminal_read", "bash"]);
		expect(setAgentToolEnabled(s, "terminal_read", false)).toBe(true);
		expect(s.peek()).toEqual(["bash"]);
		expect(setAgentToolEnabled(s, "terminal_read", true)).toBe(true);
		expect(s.peek()).toEqual(["bash", "terminal_read"]);
		expect(setAgentToolEnabled(s, "bash", false)).toBe(false);
		expect(setAgentToolEnabled(s, "nope", true)).toBe(false);
		const broken = {
			getActiveToolNames: () => {
				throw new Error("not ready");
			},
			setActiveToolsByName: () => {},
		};
		expect(setAgentToolEnabled(broken, "terminal_read", true)).toBe(false);
	});

	it("setAgentToolsEnabled batch returns the handled count", () => {
		const s = fakeSet();
		expect(setAgentToolsEnabled(s, [...TERMINAL_TOOL_NAMES], true)).toBe(7);
		expect(s.peek()).toEqual([...TERMINAL_TOOL_NAMES]);
		expect(setAgentToolsEnabled(s, ["bash"], true)).toBe(0);
	});

	it("applyAgentToolsGating full replay: catalog added/removed, others untouched", () => {
		const s = fakeSet(["bash", "read"]);
		applyAgentToolsGating(s, []);
		const names = s.peek();
		expect(names).toContain("bash");
		expect(names).toContain("read");
		for (const t of AGENT_TOOL_CATALOG) expect(names).toContain(t.name);
		const s2 = fakeSet(["bash", "terminal_read", ASK_USER_QUESTION_TOOL_NAME]);
		applyAgentToolsGating(
			s2,
			AGENT_TOOL_CATALOG.map((t) => t.name),
		);
		expect(s2.peek()).toEqual(["bash"]);
	});
});
