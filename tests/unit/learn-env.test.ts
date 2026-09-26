import { afterEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { learnServerEnv } from "../../scripts/learn-env.mjs";

const names = [
  "PI_WEB_PORT", "PI_WEB_CWD", "PI_WEB_MANAGED", "PI_WEB_LAUNCHED_BY", "PI_WEB_TOKEN",
  "PI_WEB_ALLOW_HOSTS", "PI_WEB_ALLOW_ORIGINS", "PI_WEB_TABS",
  "LEARN_PORT", "LEARN_CWD", "LEARN_DATA_DIR", "PI_CODING_AGENT_SESSION_DIR",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("LearningHarness server environment", () => {
  it("does not inherit the running Dispatch instance's port, workspace, management or token", () => {
    process.env.PI_WEB_PORT = "8790";
    process.env.PI_WEB_CWD = "other-workspace";
    process.env.PI_WEB_MANAGED = "1";
    process.env.PI_WEB_LAUNCHED_BY = "dispatch";
    process.env.PI_WEB_TOKEN = "parent-only-token";
    process.env.PI_WEB_TABS = "chat";
    delete process.env.LEARN_PORT;
    delete process.env.LEARN_CWD;
    const env = learnServerEnv();
    expect(env.PI_WEB_PORT).toBe("8788");
    expect(env.PI_WEB_CWD).toBe(process.cwd());
    expect(env.PI_WEB_MANAGED).toBe("0");
    expect(env.PI_WEB_LAUNCHED_BY).toBe("");
    expect(env.PI_WEB_ALLOW_HOSTS).toBe("localhost,127.0.0.1");
    expect(env.PI_WEB_ALLOW_ORIGINS).toBe("");
    expect(env.PI_WEB_TOKEN).toBeUndefined();
    expect(env.PI_WEB_TABS).toBeUndefined();
  });

  it("maps explicit learning workspace, port and data dir to Dispatch's internal env", () => {
    process.env.LEARN_PORT = "18788";
    process.env.LEARN_CWD = "./sample";
    process.env.LEARN_DATA_DIR = "./local-data";
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    const env = learnServerEnv();
    expect(env.PI_WEB_PORT).toBe("18788");
    expect(env.PI_WEB_CWD).toBe(resolve("./sample"));
    expect(env.PI_WEB_DATA_DIR).toBe(resolve("./local-data"));
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe(join(resolve("./local-data"), "sessions"));
  });

  it("honors an explicit pi session directory", () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = resolve("./custom-sessions");
    expect(learnServerEnv().PI_CODING_AGENT_SESSION_DIR).toBe(process.env.PI_CODING_AGENT_SESSION_DIR);
  });
});
