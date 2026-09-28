/**
 * tutor unit tests: prompt assembly, topic context, write guard, note_write.
 * Zero tokens, zero server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TopicSummary } from "../../server/protocol.js";
import {
	activateRegisteredTool,
	buildTopicContext,
	loadTutorPrompt,
	makeNoteWriteTool,
	makeTopicWriteGuard,
	NOTE_MAX,
	noteSlug,
	renderTutorSystemPrompt,
	topicWriteViolation,
	tutorPromptPath,
	tutorToolSet,
	writeNote,
} from "../../server/tutor.js";

let dir: string;
let topic: TopicSummary;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tutor-test-"));
	mkdirSync(join(dir, "notes"));
	topic = { id: "t1", title: "Rust", goal: "Write a CLI", createdAt: 1, cwd: dir };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("tutor prompt", () => {
	it("ships engine/prompts/tutor.md and loads it", () => {
		expect(existsSync(tutorPromptPath())).toBe(true);
		const text = loadTutorPrompt();
		expect(text).toMatch(/You are the tutor in LearningHarness/);
		expect(text).toMatch(/note_write/);
		expect(text).not.toMatch(/coding assistant/);
	});

	it("falls back to a tutor (never the coding persona) when the file is missing", () => {
		const text = loadTutorPrompt(join(dir, "missing.md"));
		expect(text).toMatch(/tutor in LearningHarness/);
	});

	it("puts the tutor first and the volatile topic block last, and drops the coding identity", () => {
		const out = renderTutorSystemPrompt(
			"TUTOR",
			{
				tools: "Available tools:\n- read",
				guidelines: "Guidelines:\n- Be concise",
				persona: "You are a coding agent running on Windows. The bash tool runs Git Bash.",
				terminal: "",
				context: "",
				skills: "",
				cwd: "Current working directory: /x",
			},
			"<topic>\nTitle: Rust\n</topic>",
		);
		expect(out.startsWith("TUTOR\n\n")).toBe(true);
		expect(out.endsWith("</topic>")).toBe(true);
		expect(out).not.toMatch(/coding agent/);
		expect(out).toMatch(/You are running on Windows\. The bash tool runs Git Bash\./);
		expect(out).not.toMatch(/\n\n\n/);
	});
});

describe("buildTopicContext", () => {
	const now = new Date("2026-09-28T10:00:00Z");

	it("reports intake with no roadmap and no notes", () => {
		const ctx = buildTopicContext(topic, now);
		expect(ctx).toMatch(/^<topic>\n/);
		expect(ctx).toMatch(/Title: Rust/);
		expect(ctx).toMatch(/Goal: Write a CLI/);
		expect(ctx).toMatch(/Stage: intake/);
		expect(ctx).toMatch(/Today: 2026-09-28/);
		expect(ctx).toMatch(/Notes: none yet/);
		expect(ctx).not.toMatch(/<roadmap>/);
	});

	it("asks for a goal when none is set", () => {
		expect(buildTopicContext({ ...topic, goal: "  " }, now)).toMatch(/Goal: \(not set yet/);
	});

	it("switches to learning, inlines the roadmap and lists notes", () => {
		writeFileSync(join(dir, "roadmap.md"), "# Roadmap: Rust\n- [x] **Ownership**\n");
		writeFileSync(join(dir, "notes", "ownership.md"), "# Ownership");
		writeFileSync(join(dir, "notes", "borrowing.md"), "# Borrowing");
		writeFileSync(join(dir, "notes", "scratch.txt"), "ignored");
		const ctx = buildTopicContext(topic, now);
		expect(ctx).toMatch(/Stage: learning/);
		expect(ctx).toMatch(/Notes \(notes\/<slug>\.md\): borrowing, ownership\n/);
		expect(ctx).toMatch(/<roadmap>\n# Roadmap: Rust\n- \[x\] \*\*Ownership\*\*\n<\/roadmap>/);
	});

	it("does not inline a huge roadmap", () => {
		writeFileSync(join(dir, "roadmap.md"), "x".repeat(20_000));
		const ctx = buildTopicContext(topic, now);
		expect(ctx).toMatch(/Stage: learning/);
		expect(ctx).toMatch(/roadmap\.md is long; read it/);
		expect(ctx.length).toBeLessThan(2_000);
	});
});

describe("topicWriteViolation", () => {
	it("allows files inside the topic folder", () => {
		expect(topicWriteViolation(dir, "roadmap.md")).toBeUndefined();
		expect(topicWriteViolation(dir, join(dir, "scratch", "a.py"))).toBeUndefined();
		expect(topicWriteViolation(dir, "@scratch/x.md")).toBeUndefined();
	});

	it("blocks escapes, the folder itself, and app-owned files", () => {
		expect(topicWriteViolation(dir, "../elsewhere.md")).toMatch(/outside/);
		expect(topicWriteViolation(dir, "notes/../../x.md")).toMatch(/outside/);
		expect(topicWriteViolation(dir, join(tmpdir(), "x.md"))).toMatch(/outside/);
		expect(topicWriteViolation(dir, ".")).toMatch(/outside/);
		expect(topicWriteViolation(dir, "")).toMatch(/missing/);
		expect(topicWriteViolation(dir, "topic.json")).toMatch(/managed/);
		expect(topicWriteViolation(dir, "sessions/abc.jsonl")).toMatch(/managed/);
		expect(topicWriteViolation(dir, "notes/closures.md")).toMatch(/note_write/);
	});

	it("is case-insensitive on Windows", () => {
		if (process.platform !== "win32") return;
		expect(topicWriteViolation(dir, join(dir.toUpperCase(), "scratch", "a.md"))).toBeUndefined();
		expect(topicWriteViolation(dir, "TOPIC.JSON")).toMatch(/managed/);
	});
});

describe("makeTopicWriteGuard", () => {
	/** Run the guard's tool_call handler on one event. */
	function guard(toolName: string, input: Record<string, unknown>) {
		let handler: ((e: unknown) => unknown) | undefined;
		const pi = { on: (name: string, h: (e: unknown) => unknown) => name === "tool_call" && (handler = h) };
		(makeTopicWriteGuard(dir) as ExtensionFactory)(pi as never);
		return handler!({ type: "tool_call", toolCallId: "1", toolName, input });
	}

	it("blocks write/edit outside the folder and passes everything else", () => {
		expect(guard("write", { path: "../x.md", content: "" })).toMatchObject({ block: true });
		expect(guard("edit", { path: "topic.json", edits: [] })).toMatchObject({ block: true });
		expect(guard("write", { path: "roadmap.md", content: "" })).toBeUndefined();
		expect(guard("write", { path: "notes/a.md", content: "" })).toMatchObject({
			block: true,
			reason: expect.stringMatching(/Call note_write instead/),
		});
		expect(guard("read", { path: "../anything" })).toBeUndefined();
		expect(guard("read", { path: "notes/a.md" })).toBeUndefined();
		expect(guard("read", { path: "sessions/x.jsonl" })).toMatchObject({ block: true });
		expect(guard("grep", { pattern: "x", path: "sessions" })).toMatchObject({ block: true });
		expect(guard("ls", { path: join(dir, "sessions") })).toMatchObject({ block: true });
		expect(guard("ls", {})).toBeUndefined();
		expect(guard("bash", { command: "ls .." })).toBeUndefined();
	});
});

describe("note_write", () => {
	it("derives or validates the slug", () => {
		expect(noteSlug("Scope & Closures")).toBe("scope-closures");
		expect(noteSlug("Anything", "event-loop")).toBe("event-loop");
		expect(noteSlug("Anything", "event-loop.md")).toBe("event-loop");
		expect(() => noteSlug("x", "../evil")).toThrow();
		expect(() => noteSlug("x", "Upper Case")).toThrow();
	});

	it("creates, then replaces, a note atomically", () => {
		const a = writeNote(dir, "Closures", "# Closures\r\n\r\nA closure captures.\n");
		expect(a).toEqual({
			kind: "note",
			title: "Closures",
			slug: "closures",
			path: "notes/closures.md",
			content: "# Closures\n\nA closure captures.",
			created: true,
		});
		expect(readFileSync(join(dir, "notes", "closures.md"), "utf8")).toBe("# Closures\n\nA closure captures.\n");

		const b = writeNote(dir, "Closures", "# Closures\n\nDeeper.");
		expect(b.created).toBe(false);
		expect(readFileSync(join(dir, "notes", "closures.md"), "utf8")).toBe("# Closures\n\nDeeper.\n");
	});

	it("rejects empty and oversized notes", () => {
		expect(() => writeNote(dir, "", "x")).toThrow();
		expect(() => writeNote(dir, "T", "   ")).toThrow();
		expect(() => writeNote(dir, "T", "x".repeat(NOTE_MAX + 1))).toThrow();
	});

	it("tool returns a short text for the model and the note in details", async () => {
		const tool = makeNoteWriteTool(dir);
		const res = (await tool.execute("id", { title: "Ownership", content: "# Ownership\n\nOne owner." }, undefined, undefined, {} as never)) as {
			content: { type: string; text: string }[];
			details: { path: string; content: string };
		};
		expect(res.content[0].text).toMatch(/Created notes\/ownership\.md/);
		expect(res.content[0].text).not.toMatch(/One owner/);
		expect(res.details).toMatchObject({ path: "notes/ownership.md", content: "# Ownership\n\nOne owner." });
	});
});

describe("activateRegisteredTool", () => {
	/** Fake session: pi registers custom tools inactive. */
	function session(registered: string[], active: string[]) {
		return {
			active: [...active],
			getActiveToolNames() {
				return this.active;
			},
			getToolDefinition: (n: string) => (registered.includes(n) ? { name: n } : undefined),
			setActiveToolsByName(names: string[]) {
				this.active = names;
			},
		};
	}

	it("switches on a registered but inactive tool, keeping the rest", () => {
		const s = session(["read", "note_write"], ["read", "bash"]);
		activateRegisteredTool(s, "note_write");
		expect(s.active).toEqual(["read", "bash", "note_write"]);
		activateRegisteredTool(s, "note_write");
		expect(s.active).toEqual(["read", "bash", "note_write"]);
	});

	it("does nothing when the tool is not registered (non-topic chats)", () => {
		const s = session(["read"], ["read"]);
		activateRegisteredTool(s, "note_write");
		expect(s.active).toEqual(["read"]);
	});
});

describe("tutorToolSet", () => {
	const registered = ["read", "bash", "edit", "write", "write_note", "read_note", "delegate", "web_search", "note_write"];

	it("drops the user's extension tools and turns note_write on", () => {
		const active = ["read", "bash", "edit", "write", "inspect_git", "write_note", "read_note", "delegate", "todo", "web_search", "ask_user_question"];
		expect(tutorToolSet(active, registered)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"web_search",
			"ask_user_question",
			"note_write",
		]);
	});

	it("keeps persistent terminal tools and does not invent unregistered ones", () => {
		expect(tutorToolSet(["read", "terminal_create"], ["read"])).toEqual(["read", "terminal_create"]);
	});
});
