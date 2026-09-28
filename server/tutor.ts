/**
 * tutor — what turns a topic conversation into a tutoring session.
 *
 *   - the tutor system prompt (engine/prompts/tutor.md, re-read every run so
 *     it can be iterated on without a rebuild), laid out cache-first: stable
 *     instructions, then tools/skills, then the volatile <topic> block last;
 *   - the <topic> block (goal, stage, roadmap, existing notes);
 *   - a write guard keeping write/edit inside the topic folder;
 *   - the `note_write` tool, whose result the web UI renders as a note card.
 *
 * Only conversations whose cwd is a known topic folder get any of this;
 * other chats keep the stock pi prompt.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TopicSummary } from "./protocol.js";
import { slugifyTitle } from "./topics.js";

/** Tool name of the note writer (the web UI keys its note card on this). */
export const NOTE_WRITE_TOOL = "note_write";
/** Roadmap file the tutor keeps in the topic folder. */
export const ROADMAP_FILE = "roadmap.md";
/** Largest roadmap inlined into the prompt; beyond this the tutor reads it. */
const ROADMAP_INLINE_MAX = 12_000;
/** Most note names listed in the prompt. */
const NOTES_LIST_MAX = 80;
/** Largest note accepted by note_write. */
export const NOTE_MAX = 60_000;
/** Canonical note slug (same shape as topic slugs). */
const NOTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Structured result of note_write (tool result `details`). */
export interface NoteWriteDetails {
	kind: "note";
	title: string;
	slug: string;
	/** Path relative to the topic folder, forward slashes. */
	path: string;
	content: string;
	created: boolean;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function resolvePkgRoot(): string {
	if (process.env.PI_WEB_PKG_ROOT) return process.env.PI_WEB_PKG_ROOT;
	const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/server or <pkg>/dist/server
	for (const c of [resolve(here, ".."), resolve(here, "..", "..")]) {
		if (existsSync(join(c, "engine", "prompts"))) return c;
	}
	return resolve(here, "..");
}

/** Path of the tutor prompt source. */
export function tutorPromptPath(): string {
	return join(resolvePkgRoot(), "engine", "prompts", "tutor.md");
}

/** Used only if tutor.md is missing, so a topic never falls back to the
 *  coding-agent persona. */
const TUTOR_FALLBACK =
	"You are the tutor in LearningHarness. Find out what the learner wants and already knows, propose a short plan and wait for their yes, then teach one idea at a time: motivate it, establish it precisely, connect it to what they know, and offer to go deeper or move on. Say plainly when you are unsure.";

/** Read the tutor prompt (fresh each run). */
export function loadTutorPrompt(file = tutorPromptPath()): string {
	try {
		const text = readFileSync(file, "utf8").trim();
		return text || TUTOR_FALLBACK;
	} catch {
		return TUTOR_FALLBACK;
	}
}

/** Stage the tutor is in, derived from the topic folder. */
export type TopicStage = "intake" | "learning";

/** Build the volatile <topic> block that closes the tutor prompt. */
export function buildTopicContext(topic: TopicSummary, now = new Date()): string {
	const roadmapFile = join(topic.cwd, ROADMAP_FILE);
	let roadmap: string | undefined;
	try {
		roadmap = readFileSync(roadmapFile, "utf8").trim();
	} catch {
		roadmap = undefined;
	}
	const stage: TopicStage = roadmap ? "learning" : "intake";

	let notes: string[] = [];
	try {
		notes = readdirSync(join(topic.cwd, "notes"))
			.filter((n) => n.endsWith(".md"))
			.sort();
	} catch {
		notes = [];
	}

	const lines = [
		"<topic>",
		`Title: ${topic.title}`,
		`Goal: ${topic.goal.trim() || "(not set yet; pin it down during intake)"}`,
		`Folder: ${topic.cwd.replace(/\\/g, "/")}`,
		`Stage: ${stage === "intake" ? "intake (no roadmap.md yet)" : "learning (roadmap.md exists)"}`,
		`Today: ${now.toISOString().slice(0, 10)}`,
	];
	if (notes.length === 0) {
		lines.push("Notes: none yet");
	} else {
		const shown = notes.slice(0, NOTES_LIST_MAX).map((n) => n.slice(0, -3));
		const more = notes.length - shown.length;
		lines.push(`Notes (notes/<slug>.md): ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`);
	}
	if (roadmap) {
		if (roadmap.length <= ROADMAP_INLINE_MAX) {
			lines.push("", "Current roadmap.md:", "<roadmap>", roadmap, "</roadmap>");
		} else {
			lines.push("", "roadmap.md is long; read it before continuing.");
		}
	}
	lines.push("</topic>");
	return lines.join("\n");
}

/** Section texts the tutor layout draws on (from prompt-composer). */
export interface TutorSections {
	tools: string;
	guidelines: string;
	persona: string;
	terminal: string;
	context: string;
	skills: string;
	cwd: string;
}

/**
 * Full tutor system prompt. Order is cache-friendly: the tutor instructions
 * and tool/skill sections are stable across a topic's runs, the <topic>
 * block (roadmap, notes, date) changes and therefore goes last.
 */
export function renderTutorSystemPrompt(tutor: string, sections: TutorSections, topicBlock: string): string {
	// The Windows appendix opens with "You are a coding agent…"; keep its
	// shell rules, drop the identity claim.
	const persona = sections.persona.replace(/^You are a coding agent running on Windows\.\s*/, "You are running on Windows. ");
	return [
		tutor,
		sections.tools,
		sections.guidelines,
		persona,
		sections.terminal,
		sections.context,
		sections.skills,
		sections.cwd,
		topicBlock,
	]
		.map((s) => s.trim())
		.filter(Boolean)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Write guard
// ---------------------------------------------------------------------------

function fold(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Why a write to `target` (as given to write/edit, relative to the topic
 * folder or absolute) must be refused, or undefined when it is allowed.
 * Allowed: anything inside the topic folder except topic.json and sessions/.
 */
export function topicWriteViolation(topicDir: string, target: string): string | undefined {
	if (typeof target !== "string" || !target.trim()) return "missing path";
	const root = resolve(topicDir);
	const abs = resolve(root, target.replace(/^@/, ""));
	const rel = relative(fold(root), fold(abs));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		return `outside the topic folder (${root})`;
	}
	const first = rel.split(sep)[0];
	if (rel === "topic.json" || first === "sessions") return `${first} is managed by LearningHarness`;
	// Notes go through note_write so the learner sees each one as a card;
	// a plain write would save it silently.
	if (first === "notes") return `notes are saved with ${NOTE_WRITE_TOOL} (same slug to update), not ${"write/edit"}`;
	return undefined;
}

/**
 * Why a read/search of `target` must be refused, or undefined. Only the
 * topic's raw transcripts (sessions/) are off limits: the tutor's memory is
 * roadmap.md and notes/, and old transcripts mislead it (stale tool lists,
 * superseded plans). Reads elsewhere stay allowed so the learner can point
 * the tutor at their own files.
 */
export function topicReadViolation(topicDir: string, target: string): string | undefined {
	if (typeof target !== "string" || !target.trim()) return undefined;
	const root = resolve(topicDir);
	const abs = resolve(root, target.replace(/^@/, ""));
	const rel = relative(fold(root), fold(abs));
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split(sep)[0] === "sessions" ? "past conversations are not part of your memory" : undefined;
}

/** Tools whose `path` argument writes a file. */
const WRITING_TOOLS = new Set(["write", "edit", "edit_soft"]);
/** Tools whose `path` argument reads or searches. */
const READING_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** pi extension: keep writes inside the topic folder and reads out of sessions/. */
export function makeTopicWriteGuard(topicDir: string): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			const writing = WRITING_TOOLS.has(event.toolName);
			if (!writing && !READING_TOOLS.has(event.toolName)) return undefined;
			const input = event.input as { path?: unknown; file_path?: unknown };
			const raw = typeof input.path === "string" ? input.path : input.file_path;
			const target = typeof raw === "string" ? raw : "";
			if (writing) {
				const why = topicWriteViolation(topicDir, target);
				if (!why) return undefined;
				const hint = why.startsWith("notes") ? `Call ${NOTE_WRITE_TOOL} instead.` : "Only write inside the topic folder.";
				return { block: true, reason: `Write blocked: ${why}. ${hint}` };
			}
			const why = topicReadViolation(topicDir, target);
			return why
				? { block: true, reason: `Read blocked: ${why}. Use roadmap.md and notes/ to pick up where you left off.` }
				: undefined;
		});
	};
}

// ---------------------------------------------------------------------------
// note_write
// ---------------------------------------------------------------------------

/**
 * Tools the tutor may use. Everything else active in the runtime (tools from
 * the user's global pi extensions: shared research notes, delegation, git
 * inspection, todo lists...) is switched off in topic conversations: those
 * tools confuse the tutor, e.g. a `write_note` next to `note_write`.
 * Web lookup tools are kept when present: they serve accuracy.
 */
const TUTOR_TOOLS = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"ask_user_question",
	NOTE_WRITE_TOOL,
	"web_search",
	"web_fetch",
	"fetch_url",
]);

/**
 * The tutor's tool loadout from the current one: keep allowed active tools
 * (plus the persistent terminal tools when the terminal setting has them on)
 * and make sure note_write is on whenever it is registered.
 */
export function tutorToolSet(active: readonly string[], registered: readonly string[]): string[] {
	const keep = active.filter((n) => TUTOR_TOOLS.has(n) || n.startsWith("terminal_"));
	if (registered.includes(NOTE_WRITE_TOOL) && !keep.includes(NOTE_WRITE_TOOL)) keep.push(NOTE_WRITE_TOOL);
	return keep;
}

/** The slice of AgentSession that tool activation needs. */
export interface ToolActivation {
	getActiveToolNames(): string[];
	getToolDefinition(name: string): unknown;
	setActiveToolsByName(names: string[]): void;
}

/**
 * Switch on a registered custom tool. pi registers `customTools` but only
 * activates read/bash/edit/write by default, so a tool the model should see
 * must be added to the active set. No-op when the tool isn't registered on
 * this session (non-topic runtimes) or is already active.
 */
export function activateRegisteredTool(session: ToolActivation, name: string): void {
	try {
		if (!session.getToolDefinition(name)) return;
		const active = session.getActiveToolNames();
		if (!active.includes(name)) session.setActiveToolsByName([...active, name]);
	} catch {
		// Session not ready: the next gating pass applies it.
	}
}

/** Resolve the slug note_write will use. Throws on an unusable explicit slug. */
export function noteSlug(title: string, slug?: string): string {
	if (typeof slug === "string" && slug.trim()) {
		const s = slug.trim().replace(/\.md$/i, "");
		if (!NOTE_SLUG_RE.test(s)) throw new Error(`Invalid note slug "${slug}" (use lowercase-kebab-case)`);
		return s;
	}
	return slugifyTitle(title);
}

/** Write (create or replace) one note atomically; returns the card details. */
export function writeNote(topicDir: string, title: string, content: string, slug?: string): NoteWriteDetails {
	const cleanTitle = typeof title === "string" ? title.trim() : "";
	if (!cleanTitle) throw new Error("Note title must not be empty");
	const body = typeof content === "string" ? content.replace(/\r\n/g, "\n").trim() : "";
	if (!body) throw new Error("Note content must not be empty");
	if (body.length > NOTE_MAX) throw new Error(`Note is too long (max ${NOTE_MAX} characters); split it`);
	const s = noteSlug(cleanTitle, slug);
	const dir = join(topicDir, "notes");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${s}.md`);
	const created = !existsSync(file);
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, body + "\n", "utf8");
	renameSync(tmp, file);
	return { kind: "note", title: cleanTitle, slug: s, path: `notes/${s}.md`, content: body, created };
}

/** The note_write tool for one topic folder. */
export function makeNoteWriteTool(topicDir: string): ToolDefinition {
	return {
		name: NOTE_WRITE_TOOL,
		label: "Write note",
		description:
			"Save the note for one concept to notes/<slug>.md in the topic folder (creates or replaces it). The learner sees the note rendered as a card in the chat, so do not repeat its content in your message. Reuse the same slug to extend a note when going deeper.",
		promptSnippet: "save a concept note (shown to the learner as a note card)",
		promptGuidelines: [
			"Write concept notes with note_write (write/edit on notes/ is blocked); the learner already sees the note as a card, so never repeat its content in chat",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Concept name, used as the note heading" }),
			slug: Type.Optional(
				Type.String({ description: "lowercase-kebab-case file name without .md; defaults to the slugified title" }),
			),
			content: Type.String({ description: "Full markdown of the note, starting with '# <Concept>'" }),
		}),
		execute: async (_id: string, params: unknown) => {
			const p = params as { title: string; slug?: string; content: string };
			const details = writeNote(topicDir, p.title, p.content, p.slug);
			return {
				content: [
					{
						type: "text" as const,
						text: `${details.created ? "Created" : "Updated"} ${details.path}. The learner can see it as a note card; do not repeat it.`,
					},
				],
				details,
			};
		},
	} as ToolDefinition;
}
