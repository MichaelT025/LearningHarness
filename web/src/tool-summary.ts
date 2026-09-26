/**
 * One-line, human-readable summary for a collapsed tool call — the thing the
 * shimmer runs over while the tool works ("Reading src/app.ts", "Running
 * `git status`", "Searching "TODO""). Present tense while running, past tense
 * once the result landed. Pure: takes the hints already scanned by
 * tool-args.ts, never touches the DOM.
 */
import type { ToolArgHints } from "./tool-args";
import { shortenPath } from "./tool-args";

export type ToolPhase = "running" | "done";

export interface ToolSummary {
	/** Leading verb, already in the right tense. */
	verb: string;
	/** What the verb acts on (path / command / pattern / agent); undefined when unknown. */
	target?: string;
	/** Render the target in the mono face (commands, paths, patterns). */
	mono: boolean;
	/** Full untruncated target for the title tooltip. */
	title?: string;
}

interface Verbs {
	running: string;
	done: string;
}

const VERBS: Record<string, Verbs> = {
	bash: { running: "Running", done: "Ran" },
	read: { running: "Reading", done: "Read" },
	write: { running: "Writing", done: "Wrote" },
	edit: { running: "Editing", done: "Edited" },
	edit_soft: { running: "Editing", done: "Edited" },
	grep: { running: "Searching", done: "Searched" },
	find: { running: "Finding", done: "Found" },
	glob: { running: "Finding", done: "Found" },
	ls: { running: "Listing", done: "Listed" },
	delegate: { running: "Delegating to", done: "Delegated to" },
	web_fetch: { running: "Fetching", done: "Fetched" },
	fetch: { running: "Fetching", done: "Fetched" },
	web_search: { running: "Searching the web for", done: "Searched the web for" },
};

const FALLBACK: Verbs = { running: "Calling", done: "Called" };

/** Collapse a multi-line command to its first line, 72 chars, `+N` for the rest. */
export function commandPreview(command: string, max = 72): string | undefined {
	const lines = command.split("\n");
	const first = lines[0].replace(/\s+/g, " ").trim();
	if (!first) return undefined;
	const rest = lines.length - 1;
	const short = first.length > max ? `${first.slice(0, max)}…` : first;
	return rest > 0 ? `${short} +${rest}` : short;
}

export function toolSummary(name: string, hints: ToolArgHints, phase: ToolPhase): ToolSummary {
	const verbs = VERBS[name] ?? FALLBACK;
	const verb = verbs[phase];
	const cmd = hints.command ?? hints.commandPreview;

	switch (name) {
		case "bash": {
			const preview = cmd ? commandPreview(cmd) : undefined;
			return { verb, target: preview, mono: true, title: cmd };
		}
		case "grep":
		case "find":
		case "glob":
		case "web_search": {
			const pat = hints.pattern;
			if (pat) {
				const where = hints.path ? ` in ${shortenPath(hints.path, 40)}` : "";
				return { verb, target: `"${pat}"${where}`, mono: true, title: hints.path ? `${pat} in ${hints.path}` : pat };
			}
			return { verb, target: hints.path ? shortenPath(hints.path) : undefined, mono: true, title: hints.path };
		}
		case "delegate": {
			// "2 general + review" — counts per role, in first-seen order.
			const roles = hints.roles ?? [];
			if (roles.length === 0) return { verb: phase === "running" ? "Delegating" : "Delegated", mono: false };
			const counts = new Map<string, number>();
			for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
			const target = [...counts].map(([r, n]) => (n > 1 ? `${n} ${r}` : r)).join(" + ");
			const title = `${roles.length} worker${roles.length === 1 ? "" : "s"}: ${target}`;
			return { verb, target, mono: false, title };
		}
		default: {
			if (hints.path) return { verb, target: shortenPath(hints.path), mono: true, title: hints.path };
			if (VERBS[name]) return { verb, mono: false };
			// unknown tool: "Calling my_tool"
			return { verb, target: name, mono: true, title: name };
		}
	}
}
