import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TopicStore } from "../../server/topics.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pi sessions isolated by learning topic", () => {
  it("resumes only the selected topic's transcript after a store restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "learn-topic-sessions-"));
    roots.push(dataDir);
    const topics = new TopicStore(dataDir);
    const a = topics.create("Algebra");
    const b = topics.create("Music");
    const aRoot = topics.sessionDirForCwd(a.cwd)!;
    const bRoot = topics.sessionDirForCwd(b.cwd)!;
    const aSession = SessionManager.create(a.cwd, aRoot);
    aSession.appendMessage({ role: "user", content: [{ type: "text", text: "algebra only" }], timestamp: Date.now() });
    aSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "algebra response" }], stopReason: "stop", timestamp: Date.now() } as Parameters<typeof aSession.appendMessage>[0]);
    const bSession = SessionManager.create(b.cwd, bRoot);
    bSession.appendMessage({ role: "user", content: [{ type: "text", text: "music only" }], timestamp: Date.now() });
    bSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "music response" }], stopReason: "stop", timestamp: Date.now() } as Parameters<typeof bSession.appendMessage>[0]);

    const restarted = new TopicStore(dataDir);
    expect(restarted.list()).toHaveLength(2);
    const aHistory = await SessionManager.list(a.cwd, restarted.sessionDirForCwd(a.cwd));
    const bHistory = await SessionManager.list(b.cwd, restarted.sessionDirForCwd(b.cwd));
    expect(aHistory.map((s) => s.path)).toEqual([aSession.getSessionFile()]);
    expect(bHistory.map((s) => s.path)).toEqual([bSession.getSessionFile()]);
    expect(SessionManager.continueRecent(a.cwd, restarted.sessionDirForCwd(a.cwd)).getSessionFile()).toBe(aSession.getSessionFile());
    expect(SessionManager.continueRecent(b.cwd, restarted.sessionDirForCwd(b.cwd)).getSessionFile()).toBe(bSession.getSessionFile());
  });
});
