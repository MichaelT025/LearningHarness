// Dev backend launcher: LEARN_PORT selects the isolated backend port;
// DISPATCH_DEV_PORT selects Vite's port (default 5173). E.g. `LEARN_PORT=8789
// DISPATCH_DEV_PORT=5174 npm run dev` runs beside a default instance.
//
// Use tsx watch rather than node --watch: on Windows volumes with last-access
// updates enabled, libuv may treat file reads as changes and restart repeatedly.
// chokidar (tsx) ignores atime-only events.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { learnServerEnv } from "./learn-env.mjs";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const devPort = Number(process.env.DISPATCH_DEV_PORT) || 5173;
const env = learnServerEnv();
const backendPort = Number(env.PI_WEB_PORT);

const child = spawn(process.execPath, [tsxCli, "watch", "--clear-screen=false", "server/index.ts"], {
	// No stdin: tsx watch stalls behind a never-closing pipe (what concurrently
	// hands its children) and the server never binds.
	stdio: ["ignore", "inherit", "inherit"],
	env: {
		...env,
		PI_WEB_ALLOW_ORIGINS: `http://localhost:${devPort},http://127.0.0.1:${devPort}`,
	},
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
