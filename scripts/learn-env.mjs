import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Dispatch-WebUI uses PI_WEB_* internally. Do not inherit another running
// Dispatch instance's port, workspace, managed mode, or UI state by accident.
export function learnServerEnv() {
  const dataDir = resolve(process.env.LEARN_DATA_DIR ?? join(homedir(), ".learning-harness"));
  const env = {
    ...process.env,
    PI_WEB_PORT: String(Number(process.env.LEARN_PORT) || 8788),
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_CWD: resolve(process.env.LEARN_CWD ?? process.cwd()),
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_PKG_ROOT: resolve(process.cwd()),
    PI_WEB_MANAGED: "0",
    PI_WEB_LAUNCHED_BY: "",
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR ?? join(dataDir, "sessions"),
  };
  // A parent Dispatch instance may protect its own UI with a token. A local
  // LearningHarness login uses pi credentials, not that instance's web token.
  delete env.PI_WEB_TOKEN;
  return env;
}
