/**
 * topics — durable topic metadata store.
 *
 * A topic is a private learning workspace under `<dataDir>/topics/<UUID>/`
 * with three siblings:
 *
 *   topic.json   — the versioned metadata record (atomic write)
 *   workspace/   — the directory the agent operates in (TopicSummary.cwd)
 *   sessions/    — flat pi JSONL session files for this topic
 *
 * Everything here is best-effort on read: a corrupt/malformed topic folder
 * must never prevent the server from starting. On construction the store
 * scans the topic root once and silently drops entries it cannot trust.
 *
 * Trust rules for a scanned folder (required — a topic folder name is used to
 * build paths, so an arbitrary name must never be followed):
 *   - the directory entry must be a real directory, never a symlink;
 *   - the folder name must be a canonical UUID;
 *   - topic.json must parse to version 1, carry that same id, and name the
 *     expected workspace cwd.
 * Anything else is ignored, not thrown.
 */
import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type { TopicSummary } from "./protocol.js";

/** Metadata record version written into topic.json. */
export const TOPIC_METADATA_VERSION = 1;
/** Maximum title length (after trimming). */
export const TOPIC_TITLE_MAX = 120;
/** Maximum goal length (after trimming). */
export const TOPIC_GOAL_MAX = 4000;

/** Canonical UUID shape (randomUUID output, case-insensitive for reading). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persisted on-disk shape (adds the version to the public summary). */
interface TopicMetadata extends TopicSummary {
	version: typeof TOPIC_METADATA_VERSION;
}

/**
 * Normalize a cwd for comparison. Windows paths are case-insensitive, so fold
 * case there; everywhere else leave the resolved path as-is. `resolve` also
 * collapses `.`/`..` and mixed separators.
 */
export function normalizeTopicCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Trim and validate a title; throws on empty/oversized input. */
function normalizeTitle(title: string): string {
	const trimmed = typeof title === "string" ? title.trim() : "";
	if (!trimmed) throw new Error("Topic title must not be empty");
	if (trimmed.length > TOPIC_TITLE_MAX) {
		throw new Error(`Topic title must be at most ${TOPIC_TITLE_MAX} characters`);
	}
	return trimmed;
}

/** Trim and validate an optional goal; throws when oversized. */
function normalizeGoal(goal: string | undefined): string {
	const trimmed = typeof goal === "string" ? goal.trim() : "";
	if (trimmed.length > TOPIC_GOAL_MAX) {
		throw new Error(`Topic goal must be at most ${TOPIC_GOAL_MAX} characters`);
	}
	return trimmed;
}

/** Copy out of the store so callers cannot mutate cached summaries. */
function clone(topic: TopicSummary): TopicSummary {
	return { ...topic };
}

export class TopicStore {
	/** `<dataDir>/topics` — the parent of every UUID topic folder. */
	private readonly topicsDir: string;
	/** In-memory summaries, newest first (stable for equal createdAt). */
	private readonly topics: TopicSummary[];

	constructor(dataDir: string) {
		this.topicsDir = join(dataDir, "topics");
		this.topics = this.loadFromDisk();
	}

	/**
	 * Scan `<dataDir>/topics` once. Never throws: unreadable roots, broken
	 * JSON and untrusted folder names are all skipped.
	 */
	private loadFromDisk(): TopicSummary[] {
		let entries: Dirent[];
		try {
			entries = readdirSync(this.topicsDir, { withFileTypes: true });
		} catch {
			return [];
		}

		const loaded: TopicSummary[] = [];
		for (const entry of entries) {
			// `isDirectory()` is false for symlinks; the explicit lstat guard
			// keeps that true even if a platform reports otherwise.
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const id = entry.name;
			if (!UUID_RE.test(id)) continue;

			const topicDir = join(this.topicsDir, id);
			try {
				const info = lstatSync(topicDir);
				if (!info.isDirectory() || info.isSymbolicLink()) continue;
			} catch {
				continue;
			}

			const metadata = this.readMetadata(topicDir, id);
			if (metadata) loaded.push(metadata);
		}

		// Newest first; V8's sort is stable, so equal timestamps keep scan order.
		loaded.sort((a, b) => b.createdAt - a.createdAt);
		return loaded;
	}

	/** Parse + validate one topic.json, or null when it cannot be trusted. */
	private readMetadata(topicDir: string, id: string): TopicSummary | null {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(topicDir, "topic.json"), "utf8"));
		} catch {
			return null;
		}
		if (typeof raw !== "object" || raw === null) return null;
		const m = raw as Record<string, unknown>;

		if (m.version !== TOPIC_METADATA_VERSION) return null;
		if (typeof m.id !== "string" || m.id !== id) return null;
		if (typeof m.title !== "string") return null;
		const title = m.title.trim();
		if (!title || title.length > TOPIC_TITLE_MAX) return null;
		if (typeof m.goal !== "string" || m.goal.length > TOPIC_GOAL_MAX) return null;
		if (typeof m.createdAt !== "number" || !Number.isFinite(m.createdAt) || m.createdAt <= 0) return null;
		if (typeof m.cwd !== "string" || !m.cwd) return null;
		// Metadata must point at this topic's own workspace — never elsewhere.
		if (normalizeTopicCwd(m.cwd) !== normalizeTopicCwd(join(topicDir, "workspace"))) return null;

		return { id, title, goal: m.goal, createdAt: m.createdAt, cwd: m.cwd };
	}

	/** All topics, newest first. */
	list(): TopicSummary[] {
		return this.topics.map(clone);
	}

	/** One topic by canonical id, or undefined. */
	get(id: string): TopicSummary | undefined {
		const found = this.topics.find((t) => t.id === id);
		return found ? clone(found) : undefined;
	}

	/** Topic whose workspace matches `cwd` (Windows case-folded), or undefined. */
	findByCwd(cwd: string): TopicSummary | undefined {
		const target = normalizeTopicCwd(cwd);
		const found = this.topics.find((t) => normalizeTopicCwd(t.cwd) === target);
		return found ? clone(found) : undefined;
	}

	/** Flat pi session directory for the topic at `cwd`, or undefined. */
	sessionDirForCwd(cwd: string): string | undefined {
		const topic = this.findByCwd(cwd);
		return topic ? join(this.topicsDir, topic.id, "sessions") : undefined;
	}

	/**
	 * Create a topic: allocate the UUID + workspace, write topic.json
	 * atomically (tmp file + rename), and return the summary. Throws on an
	 * invalid title/goal before touching disk.
	 */
	create(title: string, goal?: string): TopicSummary {
		const cleanTitle = normalizeTitle(title);
		const cleanGoal = normalizeGoal(goal);

		const id = randomUUID();
		const topicDir = join(this.topicsDir, id);
		const cwd = join(topicDir, "workspace");
		const createdAt = Date.now();
		const topic: TopicSummary = { id, title: cleanTitle, goal: cleanGoal, createdAt, cwd };

		mkdirSync(join(topicDir, "workspace"), { recursive: true });
		mkdirSync(join(topicDir, "sessions"), { recursive: true });
		this.writeMetadata(topicDir, topic);

		this.topics.unshift(topic);
		return clone(topic);
	}

	/** Atomic topic.json write: full temp file, then rename into place. */
	private writeMetadata(topicDir: string, topic: TopicSummary): void {
		const file = join(topicDir, "topic.json");
		const metadata: TopicMetadata = { version: TOPIC_METADATA_VERSION, ...topic };
		const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tmp, JSON.stringify(metadata, null, "\t") + "\n", "utf8");
		renameSync(tmp, file);
	}
}
