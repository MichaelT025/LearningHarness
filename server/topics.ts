/**
 * topics — durable topic metadata store.
 *
 * Topics live in the user's learning root (default `~/Documents/Learning`,
 * chosen on first run, overridable with LEARN_ROOT). Each topic is a plain,
 * human-browsable folder named by its slug:
 *
 *   <root>/<slug>/
 *     topic.json   — versioned metadata record (atomic write)
 *     notes/       — per-concept notes written by the tutor
 *     sessions/    — flat pi JSONL session files for this topic
 *
 * The topic folder itself is the agent's cwd (TopicSummary.cwd), so the
 * tutor reads/writes `notes/`, `roadmap.md` etc. relative to it.
 *
 * The root may already hold unrelated folders (the user's own material).
 * Those are never touched: a folder is a topic only when it contains a
 * trusted topic.json. Everything here is best-effort on read — a corrupt or
 * foreign folder must never prevent the server from starting.
 *
 * Trust rules for a scanned folder (a folder name is used to build paths, so
 * an arbitrary name must never be followed):
 *   - the directory entry must be a real directory, never a symlink;
 *   - the folder name must be a canonical slug;
 *   - topic.json must parse to version 2 and carry that same slug and a
 *     canonical UUID id.
 *
 * Version 1 records (`<dataDir>/topics/<UUID>/`, pre-move smoke-test data)
 * are not migrated; they simply stay where they were.
 */
import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LearnRootInfo, TopicSummary } from "./protocol.js";

/** Metadata record version written into topic.json. */
export const TOPIC_METADATA_VERSION = 2;
/** Maximum title length (after trimming). */
export const TOPIC_TITLE_MAX = 120;
/** Maximum goal length (after trimming). */
export const TOPIC_GOAL_MAX = 4000;
/** Maximum slug length (before a collision suffix). */
export const TOPIC_SLUG_MAX = 60;

/** Canonical UUID shape (randomUUID output, case-insensitive for reading). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canonical slug: lowercase ascii words joined by single hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Windows device names cannot be used as folder names on any drive. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Persisted on-disk shape. The cwd is derived from the folder, never stored,
 *  so a learning root can be moved without rewriting its topics. */
interface TopicMetadata {
	version: typeof TOPIC_METADATA_VERSION;
	id: string;
	slug: string;
	title: string;
	goal: string;
	createdAt: number;
}

/** Default learning root: ~/Documents/Learning. */
export function defaultLearnRoot(): string {
	return join(homedir(), "Documents", "Learning");
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

/**
 * Folder slug for a title: ascii-folded, lowercase, hyphen-separated,
 * capped at TOPIC_SLUG_MAX. Titles with nothing usable (e.g. only CJK or
 * punctuation) fall back to "topic"; Windows device names get a suffix.
 */
export function slugifyTitle(title: string): string {
	const base = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, TOPIC_SLUG_MAX)
		.replace(/-+$/g, "");
	if (!base) return "topic";
	return RESERVED_NAMES.test(base) ? `${base}-topic` : base;
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

/** Atomic JSON write: full temp file, then rename into place. */
function writeJsonAtomic(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", "utf8");
	renameSync(tmp, file);
}

export class TopicStore {
	/** The learning root every topic folder lives directly under. */
	private rootDir: string;
	/** In-memory summaries, newest first (stable for equal createdAt). */
	private topics: TopicSummary[];
	/** Where the root came from (server use); absent for a fixed-root store. */
	private rootConfig: LearnRootConfig | undefined;

	constructor(root: string) {
		this.rootDir = resolve(root);
		this.topics = this.loadFromDisk();
	}

	/** Store rooted wherever `config` currently points. */
	static fromConfig(config: LearnRootConfig): TopicStore {
		const store = new TopicStore(config.info().root);
		store.rootConfig = config;
		return store;
	}

	/** Root location + whether the user has confirmed it. A fixed-root store
	 *  (tests) always reports itself as configured. */
	rootInfo(): LearnRootInfo {
		return (
			this.rootConfig?.info() ?? {
				root: this.rootDir,
				configured: true,
				defaultRoot: defaultLearnRoot(),
				fromEnv: false,
			}
		);
	}

	/** Save a user-chosen root and rescan it. Throws on an invalid path or
	 *  when LEARN_ROOT pins the root. */
	configureRoot(root: string): LearnRootInfo {
		if (!this.rootConfig) throw new Error("This topic store has a fixed root");
		this.setRoot(this.rootConfig.set(root));
		return this.rootInfo();
	}

	/** Current learning root (absolute). */
	get root(): string {
		return this.rootDir;
	}

	/** Point the store at a different root and rescan it. */
	setRoot(root: string): void {
		this.rootDir = resolve(root);
		this.topics = this.loadFromDisk();
	}

	/**
	 * Scan the root once. Never throws: unreadable roots, broken JSON, foreign
	 * folders and untrusted names are all skipped.
	 */
	private loadFromDisk(): TopicSummary[] {
		let entries: Dirent[];
		try {
			entries = readdirSync(this.rootDir, { withFileTypes: true });
		} catch {
			return [];
		}

		const loaded: TopicSummary[] = [];
		const seenIds = new Set<string>();
		for (const entry of entries) {
			// `isDirectory()` is false for symlinks; the explicit lstat guard
			// keeps that true even if a platform reports otherwise.
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const slug = entry.name;
			if (!SLUG_RE.test(slug)) continue;

			const topicDir = join(this.rootDir, slug);
			try {
				const info = lstatSync(topicDir);
				if (!info.isDirectory() || info.isSymbolicLink()) continue;
			} catch {
				continue;
			}

			const topic = this.readMetadata(topicDir, slug);
			// Two folders claiming one id (a copied folder): first scanned wins.
			if (topic && !seenIds.has(topic.id)) {
				seenIds.add(topic.id);
				loaded.push(topic);
			}
		}

		// Newest first; V8's sort is stable, so equal timestamps keep scan order.
		loaded.sort((a, b) => b.createdAt - a.createdAt);
		return loaded;
	}

	/** Parse + validate one topic.json, or null when it cannot be trusted. */
	private readMetadata(topicDir: string, slug: string): TopicSummary | null {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(topicDir, "topic.json"), "utf8"));
		} catch {
			return null;
		}
		if (typeof raw !== "object" || raw === null) return null;
		const m = raw as Record<string, unknown>;

		if (m.version !== TOPIC_METADATA_VERSION) return null;
		if (typeof m.id !== "string" || !UUID_RE.test(m.id)) return null;
		if (m.slug !== slug) return null;
		if (typeof m.title !== "string") return null;
		const title = m.title.trim();
		if (!title || title.length > TOPIC_TITLE_MAX) return null;
		if (typeof m.goal !== "string" || m.goal.length > TOPIC_GOAL_MAX) return null;
		if (typeof m.createdAt !== "number" || !Number.isFinite(m.createdAt) || m.createdAt <= 0) return null;

		return { id: m.id, title, goal: m.goal, createdAt: m.createdAt, cwd: topicDir };
	}

	/** All topics, newest first. */
	list(): TopicSummary[] {
		return this.topics.map(clone);
	}

	/** One topic by id, or undefined. */
	get(id: string): TopicSummary | undefined {
		const found = this.topics.find((t) => t.id === id);
		return found ? clone(found) : undefined;
	}

	/** Topic whose folder matches `cwd` (Windows case-folded), or undefined. */
	findByCwd(cwd: string): TopicSummary | undefined {
		const target = normalizeTopicCwd(cwd);
		const found = this.topics.find((t) => normalizeTopicCwd(t.cwd) === target);
		return found ? clone(found) : undefined;
	}

	/** Flat pi session directory for the topic at `cwd`, or undefined. */
	sessionDirForCwd(cwd: string): string | undefined {
		const topic = this.findByCwd(cwd);
		return topic ? join(topic.cwd, "sessions") : undefined;
	}

	/**
	 * Create a topic: claim a fresh slug folder (suffixing -2, -3… on any
	 * collision, including unrelated folders already in the root), write
	 * topic.json atomically, and return the summary. Throws on an invalid
	 * title/goal before touching disk.
	 */
	create(title: string, goal?: string): TopicSummary {
		const cleanTitle = normalizeTitle(title);
		const cleanGoal = normalizeGoal(goal);

		mkdirSync(this.rootDir, { recursive: true });
		const base = slugifyTitle(cleanTitle);
		let slug = base;
		let topicDir = "";
		for (let n = 2; ; n++) {
			topicDir = join(this.rootDir, slug);
			try {
				// Non-recursive mkdir is the atomic claim: EEXIST means taken
				// (case-insensitively on Windows/macOS), so try the next suffix.
				mkdirSync(topicDir);
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				if (n > 999) throw new Error(`No free folder name for "${cleanTitle}"`);
				slug = `${base}-${n}`;
			}
		}

		const id = randomUUID();
		const createdAt = Date.now();
		mkdirSync(join(topicDir, "notes"), { recursive: true });
		mkdirSync(join(topicDir, "sessions"), { recursive: true });
		const metadata: TopicMetadata = {
			version: TOPIC_METADATA_VERSION,
			id,
			slug,
			title: cleanTitle,
			goal: cleanGoal,
			createdAt,
		};
		writeJsonAtomic(join(topicDir, "topic.json"), metadata);

		const topic: TopicSummary = { id, title: cleanTitle, goal: cleanGoal, createdAt, cwd: topicDir };
		this.topics.unshift(topic);
		return clone(topic);
	}
}

// ---------------------------------------------------------------------------
// Learning root configuration
// ---------------------------------------------------------------------------

/** `<dataDir>/config.json` shape (app-level config, not learning data). */
interface LearnConfig {
	version: 1;
	learnRoot?: string;
}

/**
 * Where the learning root comes from: LEARN_ROOT (fixed for this process)
 * beats the saved choice, which beats the default. Until the user confirms a
 * root (first run) `configured` is false and the UI asks.
 */
export class LearnRootConfig {
	private readonly file: string;
	private saved: string | undefined;

	constructor(
		dataDir: string,
		private readonly envRoot: string | undefined = process.env.LEARN_ROOT,
	) {
		this.file = join(dataDir, "config.json");
		this.saved = this.readSaved();
	}

	private readSaved(): string | undefined {
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LearnConfig>;
			return typeof raw.learnRoot === "string" && isAbsolute(raw.learnRoot) ? raw.learnRoot : undefined;
		} catch {
			return undefined;
		}
	}

	info(): LearnRootInfo {
		const env = this.envRoot?.trim();
		if (env) return { root: resolve(env), configured: true, defaultRoot: defaultLearnRoot(), fromEnv: true };
		return {
			root: this.saved ?? defaultLearnRoot(),
			configured: this.saved !== undefined,
			defaultRoot: defaultLearnRoot(),
			fromEnv: false,
		};
	}

	/**
	 * Save a root chosen by the user. It must be absolute; it is created when
	 * missing and must be a directory. Returns the resolved path. Throws when
	 * LEARN_ROOT pins the root for this process.
	 */
	set(root: string): string {
		if (this.envRoot?.trim()) throw new Error("The learning folder is fixed by LEARN_ROOT");
		const trimmed = typeof root === "string" ? root.trim() : "";
		if (!trimmed || !isAbsolute(trimmed)) throw new Error("Choose an absolute folder path");
		const abs = resolve(trimmed);
		mkdirSync(abs, { recursive: true });
		if (!statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
		mkdirSync(join(this.file, ".."), { recursive: true });
		writeJsonAtomic(this.file, { version: 1, learnRoot: abs } satisfies LearnConfig);
		this.saved = abs;
		return abs;
	}
}
