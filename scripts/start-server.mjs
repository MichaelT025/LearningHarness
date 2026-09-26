import { learnServerEnv } from "./learn-env.mjs";

Object.assign(process.env, learnServerEnv());
// Clear the parent Dispatch instance's token before the server module loads.
delete process.env.PI_WEB_TOKEN;
await import("../dist/server/index.js");
