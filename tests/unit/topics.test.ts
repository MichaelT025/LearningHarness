/**
 * topics unit tests: durable topic metadata store. Zero tokens, zero server.
 *
 * Covers the contract used by the rest of the app: create/validate, restart
 * persistence, distinct topic directories, cwd lookup (Windows case folding),
 * creation-descending listing, and recovery from corrupt/foreign folders.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	normalizeTopicCwd,
	TOPIC_GOAL_MAX,
	TOPIC_METADATA_VERSION,
	TOPIC_TITLE_MAX,
	TopicStore,
} from "../../server/topics.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dataDir: string;

/** A store rooted at the shared temp dataDir. */
function newStore(): TopicStore {
	return new TopicStore(dataDir);
}

function topicFile(id: string): string {
	return join(dataDir, "topics", id, "topic.json");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "topics-test-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("create", () => {
	it("trims title/goal, allocates a UUID workspace and flat session dir", () => {
		const store = newStore();
		const t = store.create("  Intro to Rust  ", "  Learn ownership  ");

		expect(t.id).toMatch(UUID_RE);
		expect(t.title).toBe("Intro to Rust");
		expect(t.goal).toBe("Learn ownership");
		expect(typeof t.createdAt).toBe("number");
		expect(t.cwd).toBe(join(dataDir, "topics", t.id, "workspace"));
		expect(existsSync(t.cwd)).toBe(true);
		expect(existsSync(join(dataDir, "topics", t.id, "sessions"))).toBe(true);

		const onDisk = JSON.parse(readFileSync(topicFile(t.id), "utf8"));
		expect(onDisk).toEqual({
			version: TOPIC_METADATA_VERSION,
			id: t.id,
			title: "Intro to Rust",
			goal: "Learn ownership",
			createdAt: t.createdAt,
			cwd: t.cwd,
		});
	});

	it("defaults a missing goal to empty string", () => {
		const t = newStore().create("No goal");
		expect(t.goal).toBe("");
	});

	it("rejects empty/whitespace and oversized title before writing", () => {
		const store = newStore();
		expect(() => store.create("")).toThrow();
		expect(() => store.create("   ")).toThrow();
		expect(() => store.create("x".repeat(TOPIC_TITLE_MAX + 1))).toThrow();
		// Nothing was created on disk.
		expect(existsSync(join(dataDir, "topics"))).toBe(false);
		expect(store.list()).toEqual([]);
	});

	it("rejects an oversized goal but accepts the exactlimits", () => {
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
		// Mutating a returned summary must not corrupt the store.
		list[0].title = "mutated";
		expect(store.get(second.id)?.title).toBe("Second");
	});

	it("get returns undefined for unknown ids", () => {
		const store = newStore();
		expect(store.get("nope")).toBeUndefined();
		expect(store.get("00000000-0000-0000-0000-000000000000")).toBeUndefined();
	});
});

describe("two distinct topic directories", () => {
	it("keeps separate workspace/sessions dirs per topic", () => {
		const store = newStore();
		const a = store.create("Alpha");
		const b = store.create("Beta");

		expect(a.id).not.toBe(b.id);
		expect(a.cwd).not.toBe(b.cwd);
		expect(store.list()).toHaveLength(2);
		expect(existsSync(a.cwd)).toBe(true);
		expect(existsSync(b.cwd)).toBe(true);
		expect(store.sessionDirForCwd(a.cwd)).toBe(join(dataDir, "topics", a.id, "sessions"));
		expect(store.sessionDirForCwd(b.cwd)).toBe(join(dataDir, "topics", b.id, "sessions"));
	});
});

describe("findByCwd / sessionDirForCwd", () => {
	it("finds by exact cwd and returns undefined otherwise", () => {
		const store = newStore();
		const t = store.create("Lookup");
		expect(store.findByCwd(t.cwd)?.id).toBe(t.id);
		expect(store.findByCwd(join(dataDir, "elsewhere"))).toBeUndefined();
		expect(store.sessionDirForCwd(join(dataDir, "elsewhere"))).toBeUndefined();
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

		const restarted = new TopicStore(dataDir);
		const list = restarted.list();
		expect(list.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
		expect(restarted.get(a.id)).toMatchObject({ title: "Persisted A", goal: "goal a", cwd: a.cwd });
		expect(restarted.get(b.id)?.title).toBe("Persisted B");
		expect(restarted.findByCwd(a.cwd)?.id).toBe(a.id);
		expect(restarted.sessionDirForCwd(b.cwd)).toBe(join(dataDir, "topics", b.id, "sessions"));
	});

	it("orders reloaded topics creation-descending", async () => {
		const first = newStore();
		const older = first.create("Older");
		await sleep(25);
		const newer = first.create("Newer");

		const restarted = new TopicStore(dataDir);
		expect(restarted.list().map((t) => t.id)).toEqual([newer.id, older.id]);
	});
});

describe("corrupt / foreign metadata recovery", () => {
	it("ignores a corrupt topic.json but keeps valid topics", () => {
		const first = newStore();
		const good = first.create("Good");
		const bad = first.create("Bad");
		writeFileSync(topicFile(bad.id), "{ not json at all");

		const restarted = new TopicStore(dataDir);
		expect(restarted.list().map((t) => t.id)).toEqual([good.id]);
		expect(restarted.get(bad.id)).toBeUndefined();
	});

	it("ignores non-UUID folder names and version/id/cwd mismatches", () => {
		const first = newStore();
		const valid = first.create("Valid");

		const topicsRoot = join(dataDir, "topics");
		// A valid-looking record in a non-UUID folder must never be followed.
		const foreign = join(topicsRoot, "not-a-uuid");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(
			join(foreign, "topic.json"),
			JSON.stringify({
				version: TOPIC_METADATA_VERSION,
				id: "not-a-uuid",
				title: "Evil",
				goal: "",
				createdAt: Date.now(),
				cwd: join(foreign, "workspace"),
			}),
		);

		// UUID folder with wrong version.
		const wrongVersion = "11111111-1111-4111-8111-111111111111";
		mkdirSync(join(topicsRoot, wrongVersion), { recursive: true });
		writeFileSync(
			join(topicsRoot, wrongVersion, "topic.json"),
			JSON.stringify({ version: 2, id: wrongVersion, title: "Wrong", goal: "", createdAt: Date.now(), cwd: join(topicsRoot, wrongVersion, "workspace") }),
		);

		// UUID folder whose metadata id does not match the folder name.
		const mismatched = "22222222-2222-4222-8222-222222222222";
		mkdirSync(join(topicsRoot, mismatched), { recursive: true });
		writeFileSync(
			join(topicsRoot, mismatched, "topic.json"),
			JSON.stringify({ version: 1, id: valid.id, title: "Mismatch", goal: "", createdAt: Date.now(), cwd: join(topicsRoot, mismatched, "workspace") }),
		);

		// UUID folder whose cwd points somewhere else.
		const wrongCwd = "33333333-3333-4333-8333-333333333333";
		mkdirSync(join(topicsRoot, wrongCwd), { recursive: true });
		writeFileSync(
			join(topicsRoot, wrongCwd, "topic.json"),
			JSON.stringify({ version: 1, id: wrongCwd, title: "Wrong cwd", goal: "", createdAt: Date.now(), cwd: join(dataDir, "somewhere-else") }),
		);

		const restarted = new TopicStore(dataDir);
		expect(restarted.list().map((t) => t.id)).toEqual([valid.id]);
	});

	it("does not follow a symlinked directory as a topic", () => {
		const first = newStore();
		first.create("Real");
		const topicsRoot = join(dataDir, "topics");

		const targetId = "44444444-4444-4444-8444-444444444444";
		const outside = join(dataDir, "outside");
		mkdirSync(join(outside, "workspace"), { recursive: true });
		writeFileSync(
			join(outside, "topic.json"),
			JSON.stringify({
				version: 1,
				id: targetId,
				title: "Symlinked",
				goal: "",
				createdAt: Date.now(),
				cwd: join(outside, "workspace"),
			}),
		);
		try {
			symlinkSync(join(outside), join(topicsRoot, targetId), "junction");
		} catch {
			return; // symlink creation unavailable (permissions) — skip.
		}

		const restarted = new TopicStore(dataDir);
		expect(restarted.get(targetId)).toBeUndefined();
		expect(restarted.list()).toHaveLength(1);
	});

	it("recovers from an entirely unreadable topics root", () => {
		const store = new TopicStore(join(dataDir, "does-not-exist"));
		expect(store.list()).toEqual([]);
		expect(store.findByCwd("whatever")).toBeUndefined();
	});
});
