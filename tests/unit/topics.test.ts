/**
 * topics unit tests: durable topic metadata store. Zero tokens, zero server.
 *
 * Covers the contract used by the rest of the app: slug folders under the
 * learning root, create/validate, restart persistence, collisions with the
 * user's own folders, cwd lookup (Windows case folding), creation-descending
 * listing, recovery from corrupt/foreign folders, and the root config.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultLearnRoot,
	LearnRootConfig,
	normalizeTopicCwd,
	slugifyTitle,
	TOPIC_GOAL_MAX,
	TOPIC_METADATA_VERSION,
	TOPIC_TITLE_MAX,
	TopicStore,
} from "../../server/topics.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let root: string;

/** A store rooted at the shared temp learning root. */
function newStore(): TopicStore {
	return new TopicStore(root);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Hand-write a topic folder (for recovery tests). */
function writeTopic(folder: string, record: Record<string, unknown>): void {
	mkdirSync(join(root, folder), { recursive: true });
	writeFileSync(join(root, folder, "topic.json"), JSON.stringify(record));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "topics-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("slugifyTitle", () => {
	it("folds to lowercase kebab-case ascii", () => {
		expect(slugifyTitle("Intro to Rust")).toBe("intro-to-rust");
		expect(slugifyTitle("  C++ / Templates!! ")).toBe("c-templates");
		expect(slugifyTitle("Café Économie")).toBe("cafe-economie");
	});

	it("falls back when nothing usable is left, and avoids device names", () => {
		expect(slugifyTitle("闭包")).toBe("topic");
		expect(slugifyTitle("???")).toBe("topic");
		expect(slugifyTitle("CON")).toBe("con-topic");
		expect(slugifyTitle("nul")).toBe("nul-topic");
	});

	it("caps length without a trailing hyphen", () => {
		const s = slugifyTitle(`${"a".repeat(59)} b`);
		expect(s.length).toBeLessThanOrEqual(60);
		expect(s.endsWith("-")).toBe(false);
	});
});

describe("create", () => {
	it("trims title/goal and makes a slug folder with notes/ and sessions/", () => {
		const store = newStore();
		const t = store.create("  Intro to Rust  ", "  Learn ownership  ");

		expect(t.id).toMatch(UUID_RE);
		expect(t.title).toBe("Intro to Rust");
		expect(t.goal).toBe("Learn ownership");
		expect(t.cwd).toBe(join(root, "intro-to-rust"));
		expect(existsSync(join(t.cwd, "notes"))).toBe(true);
		expect(existsSync(join(t.cwd, "sessions"))).toBe(true);

		const onDisk = JSON.parse(readFileSync(join(t.cwd, "topic.json"), "utf8"));
		expect(onDisk).toEqual({
			version: TOPIC_METADATA_VERSION,
			id: t.id,
			slug: "intro-to-rust",
			title: "Intro to Rust",
			goal: "Learn ownership",
			createdAt: t.createdAt,
		});
	});

	it("creates the root when it does not exist yet", () => {
		const store = new TopicStore(join(root, "nested", "Learning"));
		const t = store.create("First");
		expect(t.cwd).toBe(join(root, "nested", "Learning", "first"));
		expect(existsSync(t.cwd)).toBe(true);
	});

	it("defaults a missing goal to empty string", () => {
		expect(newStore().create("No goal").goal).toBe("");
	});

	it("suffixes the slug when the name is taken, including by the user's own folders", () => {
		mkdirSync(join(root, "python"));
		writeFileSync(join(root, "python", "my-notes.txt"), "mine");
		const store = newStore();
		const a = store.create("Python");
		const b = store.create("Python");
		expect(a.cwd).toBe(join(root, "python-2"));
		expect(b.cwd).toBe(join(root, "python-3"));
		// The user's folder is untouched and never becomes a topic.
		expect(readdirSync(join(root, "python"))).toEqual(["my-notes.txt"]);
		expect(store.list()).toHaveLength(2);
	});

	it("rejects empty/whitespace and oversized title before writing", () => {
		const store = newStore();
		expect(() => store.create("")).toThrow();
		expect(() => store.create("   ")).toThrow();
		expect(() => store.create("x".repeat(TOPIC_TITLE_MAX + 1))).toThrow();
		expect(readdirSync(root)).toEqual([]);
		expect(store.list()).toEqual([]);
	});

	it("rejects an oversized goal but accepts the exact limits", () => {
		const store = newStore();
		expect(() => store.create("ok", "g".repeat(TOPIC_GOAL_MAX + 1))).toThrow();

		const t = store.create("x".repeat(TOPIC_TITLE_MAX), "g".repeat(TOPIC_GOAL_MAX));
		expect(t.title).toHaveLength(TOPIC_TITLE_MAX);
		expect(t.goal).toHaveLength(TOPIC_GOAL_MAX);
	});
});

describe("list/get", () => {
	it("lists newest first and is a defensive copy", () => {
		const store = newStore();
		const first = store.create("First");
		const second = store.create("Second");

		const list = store.list();
		expect(list.map((t) => t.id)).toEqual([second.id, first.id]);
		list[0].title = "mutated";
		expect(store.get(second.id)?.title).toBe("Second");
	});

	it("get returns undefined for unknown ids", () => {
		const store = newStore();
		expect(store.get("nope")).toBeUndefined();
		expect(store.get("00000000-0000-0000-0000-000000000000")).toBeUndefined();
	});
});

describe("findByCwd / sessionDirForCwd", () => {
	it("maps each topic folder to its own sessions dir", () => {
		const store = newStore();
		const a = store.create("Alpha");
		const b = store.create("Beta");
		expect(store.sessionDirForCwd(a.cwd)).toBe(join(root, "alpha", "sessions"));
		expect(store.sessionDirForCwd(b.cwd)).toBe(join(root, "beta", "sessions"));
		expect(store.findByCwd(a.cwd)?.id).toBe(a.id);
		expect(store.findByCwd(join(root, "elsewhere"))).toBeUndefined();
		expect(store.sessionDirForCwd(join(root, "elsewhere"))).toBeUndefined();
		// A subfolder of a topic is not the topic.
		expect(store.findByCwd(join(a.cwd, "notes"))).toBeUndefined();
	});

	it("case-folds cwd on Windows", () => {
		if (process.platform !== "win32") return;
		const store = newStore();
		const t = store.create("Case");
		expect(store.findByCwd(t.cwd.toUpperCase())?.id).toBe(t.id);
		expect(normalizeTopicCwd(t.cwd)).toBe(normalizeTopicCwd(t.cwd.toUpperCase()));
	});
});

describe("restart persistence", () => {
	it("reloads topics from disk in a fresh store", () => {
		const first = newStore();
		const a = first.create("Persisted A", "goal a");
		const b = first.create("Persisted B");

		const restarted = newStore();
		expect(restarted.list().map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
		expect(restarted.get(a.id)).toMatchObject({ title: "Persisted A", goal: "goal a", cwd: a.cwd });
		expect(restarted.sessionDirForCwd(b.cwd)).toBe(join(b.cwd, "sessions"));
	});

	it("orders reloaded topics creation-descending", async () => {
		const first = newStore();
		const older = first.create("Older");
		await sleep(25);
		const newer = first.create("Newer");
		expect(newStore().list().map((t) => t.id)).toEqual([newer.id, older.id]);
	});

	it("follows a moved root: the cwd comes from the folder, not the record", () => {
		const t = newStore().create("Portable");
		const moved = mkdtempSync(join(tmpdir(), "topics-moved-"));
		try {
			const record = readFileSync(join(t.cwd, "topic.json"), "utf8");
			mkdirSync(join(moved, "portable"));
			writeFileSync(join(moved, "portable", "topic.json"), record);
			const store = new TopicStore(moved);
			expect(store.get(t.id)?.cwd).toBe(join(moved, "portable"));
		} finally {
			rmSync(moved, { recursive: true, force: true });
		}
	});

	it("setRoot rescans", () => {
		const store = newStore();
		store.create("Here");
		const other = mkdtempSync(join(tmpdir(), "topics-other-"));
		try {
			store.setRoot(other);
			expect(store.list()).toEqual([]);
			store.setRoot(root);
			expect(store.list()).toHaveLength(1);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("corrupt / foreign folder recovery", () => {
	it("ignores a corrupt topic.json but keeps valid topics", () => {
		const first = newStore();
		const good = first.create("Good");
		const bad = first.create("Bad");
		writeFileSync(join(bad.cwd, "topic.json"), "{ not json at all");

		const restarted = newStore();
		expect(restarted.list().map((t) => t.id)).toEqual([good.id]);
	});

	it("ignores plain folders, non-slug names, slug/version/id mismatches and duplicate ids", () => {
		const valid = newStore().create("Valid");
		const record = (over: Record<string, unknown>) => ({
			version: TOPIC_METADATA_VERSION,
			id: "11111111-1111-4111-8111-111111111111",
			slug: "x",
			title: "T",
			goal: "",
			createdAt: Date.now(),
			...over,
		});

		mkdirSync(join(root, "ReactLearn")); // the user's own folder, no topic.json
		writeTopic("Not A Slug", record({ slug: "Not A Slug" }));
		writeTopic("mismatch", record({ slug: "other" }));
		writeTopic("old-version", record({ version: 1, slug: "old-version" }));
		writeTopic("bad-id", record({ id: "not-a-uuid", slug: "bad-id" }));
		writeTopic("zz-copy", record({ id: valid.id, slug: "zz-copy" }));

		const restarted = newStore();
		expect(restarted.list().map((t) => t.id)).toEqual([valid.id]);
		expect(restarted.get(valid.id)?.cwd).toBe(valid.cwd);
	});

	it("does not follow a symlinked directory as a topic", () => {
		newStore().create("Real");
		const outside = mkdtempSync(join(tmpdir(), "topics-outside-"));
		try {
			writeFileSync(
				join(outside, "topic.json"),
				JSON.stringify({
					version: TOPIC_METADATA_VERSION,
					id: "44444444-4444-4444-8444-444444444444",
					slug: "linked",
					title: "Symlinked",
					goal: "",
					createdAt: Date.now(),
				}),
			);
			try {
				symlinkSync(outside, join(root, "linked"), "junction");
			} catch {
				return; // symlink creation unavailable (permissions) — skip.
			}
			const restarted = newStore();
			expect(restarted.get("44444444-4444-4444-8444-444444444444")).toBeUndefined();
			expect(restarted.list()).toHaveLength(1);
		} finally {
			rmSync(join(root, "linked"), { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("recovers from an unreadable root", () => {
		const store = new TopicStore(join(root, "does-not-exist"));
		expect(store.list()).toEqual([]);
		expect(store.findByCwd("whatever")).toBeUndefined();
	});
});

describe("LearnRootConfig", () => {
	it("starts unconfigured on the default root, then saves a chosen root", () => {
		const cfg = new LearnRootConfig(root, undefined);
		expect(cfg.info()).toEqual({
			root: defaultLearnRoot(),
			configured: false,
			defaultRoot: defaultLearnRoot(),
			fromEnv: false,
		});

		const chosen = join(root, "My Learning");
		expect(cfg.set(chosen)).toBe(chosen);
		expect(existsSync(chosen)).toBe(true);
		expect(cfg.info()).toMatchObject({ root: chosen, configured: true });
		// Survives a restart.
		expect(new LearnRootConfig(root, undefined).info()).toMatchObject({ root: chosen, configured: true });
	});

	it("rejects relative paths and files", () => {
		const cfg = new LearnRootConfig(root, undefined);
		expect(() => cfg.set("relative/path")).toThrow();
		expect(() => cfg.set("   ")).toThrow();
		const file = join(root, "a-file");
		writeFileSync(file, "x");
		expect(() => cfg.set(file)).toThrow();
		expect(cfg.info().configured).toBe(false);
	});

	it("LEARN_ROOT wins and cannot be changed from the UI", () => {
		const pinned = join(root, "pinned");
		const cfg = new LearnRootConfig(root, pinned);
		expect(cfg.info()).toMatchObject({ root: pinned, configured: true, fromEnv: true });
		expect(() => cfg.set(join(root, "other"))).toThrow(/LEARN_ROOT/);
	});

	it("drives a store: configureRoot saves and rescans", () => {
		const store = TopicStore.fromConfig(new LearnRootConfig(root, undefined));
		expect(store.rootInfo().configured).toBe(false);
		const chosen = join(root, "chosen");
		const info = store.configureRoot(chosen);
		expect(info).toMatchObject({ root: chosen, configured: true });
		expect(store.create("After").cwd).toBe(join(chosen, "after"));
	});
});
