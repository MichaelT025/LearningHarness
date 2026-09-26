/**
 * Phase-0 adapted Dispatch-WebUI server chat bridge (spike).
 *
 * - Binds 127.0.0.1, default port 8788 (LEARN_PORT override).
 * - GET /api/health -> { ok, cwd, pid }.
 * - Serves web/dist statically in production when present.
 * - WS /ws carries the protocol in ./protocol.js with same-authority Origin
 *   validation and a frame size limit.
 * - One SDK session per socket (cwd from LEARN_CWD or process.cwd());
 *   dispose on socket close; abort message aborts the run; errors surface
 *   as { type: 'error' } payloads.
 *
 * Deliberately NOT copied from Dispatch-WebUI: AgentService, tabs, terminals,
 * worktrees, subscriptions, model admin, file services (baseline 8dc1df5).
 * SDK baseline: @earendil-works/pi-coding-agent 0.87.1.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { ChatSession, defaultDeps, type ChatSessionDeps } from "./chat-session.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.LEARN_PORT ?? 8788);
const HOST = "127.0.0.1";
const CWD = resolve(process.env.LEARN_CWD ?? process.cwd());
/** Max inbound WS frame / prompt text (1 MiB): spike-sized, not Dispatch's 256 MiB. */
const MAX_TEXT_BYTES = 1_048_576;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Production static root that works in both runtimes:
 * - tsx dev (`server/index.ts`):        <root>/server        -> ../web/dist
 * - compiled start (`dist/server/*.js`): <root>/dist/server   -> ../../web/dist
 * `LEARN_WEB_DIST` overrides; the process-cwd layout is a last fallback.
 */
export function resolveWebDist(fromDir: string = here): string | null {
	const candidates = [
		process.env.LEARN_WEB_DIST,
		resolve(fromDir, "..", "web", "dist"),
		resolve(fromDir, "..", "..", "web", "dist"),
		resolve(process.cwd(), "web", "dist"),
	];
	for (const c of candidates) {
		if (c && existsSync(c)) return resolve(c);
	}
	return null;
}

/**
 * Map a URL pathname to an absolute file under `webRoot`, or null for 404.
 * - `..` traversal outside the root is rejected.
 * - Missing asset paths (any file extension) and /api/* never get the SPA
 *   fallback — only extensionless routes fall back to index.html.
 */
export function resolveStaticFile(webRoot: string, pathname: string): string | null {
	let rel: string;
	try {
		rel = decodeURIComponent(pathname).replace(/^\/+/, "");
	} catch {
		return null;
	}
	const file = resolve(webRoot, rel);
	if (file !== webRoot && !file.startsWith(webRoot + sep)) return null; // traversal
	try {
		const st = statSync(file, { throwIfNoEntry: false });
		if (st?.isFile()) return file;
	} catch {
		return null;
	}
	if (pathname.startsWith("/api/")) return null;
	if (extname(file) !== "") return null; // missing asset -> 404, not index.html
	const index = join(webRoot, "index.html");
	return existsSync(index) ? index : null;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

function serveHealth(_req: IncomingMessage, res: ServerResponse): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true, cwd: CWD, pid: process.pid }));
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
	const webRoot = resolveWebDist();
	if (!webRoot) return false;
	const file = resolveStaticFile(webRoot, pathname);
	if (!file) return false;
	try {
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
		});
		res.end(readFileSync(file));
		return true;
	} catch {
		return false;
	}
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		res.writeHead(400).end();
		return;
	}
	if (req.method === "GET" && pathname === "/api/health") {
		serveHealth(req, res);
		return;
	}
	if (req.method === "GET" && serveStatic(pathname, res)) return;
	res.writeHead(404).end("not found");
}

/** host or host:port -> lowercased hostname + port (default 80). */
function parseAuthority(a: string): { hostname: string; port: string } {
	try {
		const u = new URL(`http://${a}`);
		return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
	} catch {
		return { hostname: "", port: "" };
	}
}

/**
 * Loopback literals only. Anything else as Host/Origin is a DNS-rebinding
 * suspect (attacker domain resolving to 127.0.0.1), even when Host and
 * Origin match each other. WHATWG URL keeps IPv6 brackets in `hostname`,
 * so both `::1` and `[::1]` are accepted.
 */
function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

/**
 * Upgrade admission: the server binds 127.0.0.1 only, so the Host must be a
 * loopback authority and a browser Origin must be same-authority http(s).
 * Vite dev proxies /ws with a `localhost:5173` Host, which is accepted.
 */
export function originAllowed(req: IncomingMessage): boolean {
	const host = parseAuthority((req.headers.host ?? "").toLowerCase());
	// Rebinding guard first: reject evil.com -> 127.0.0.1 outright, even when
	// Origin matches the spoofed Host.
	if (!isLoopbackHostname(host.hostname)) return false;
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser client on loopback
	let o: URL;
	try {
		o = new URL(origin);
	} catch {
		return false; // includes the opaque "null" origin
	}
	// Browsers send the page's http(s) origin on WS upgrades; anything else
	// (file:, ws:, custom schemes) is not a trusted web page.
	if (o.protocol !== "http:" && o.protocol !== "https:") return false;
	const oriHostname = o.hostname.toLowerCase();
	if (oriHostname !== host.hostname) return false; // same-authority host
	if (!isLoopbackHostname(oriHostname)) return false; // belt-and-braces
	const oriPort = o.port || (o.protocol === "https:" ? "443" : "80");
	if (oriPort !== host.port) return false; // same-authority port
	return true;
}

const httpServer = createServer(handleHttp);
const wss = new WebSocketServer({
	noServer: true,
	maxPayload: MAX_TEXT_BYTES,
});

httpServer.on("upgrade", (req, socket, head) => {
	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		socket.destroy();
		return;
	}
	if (pathname !== "/ws") {
		socket.destroy();
		return;
	}
	if (!originAllowed(req)) {
		socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

export interface ConnectionOptions {
	cwd: string;
	deps?: ChatSessionDeps;
}

/**
 * Per-socket WS handler (extracted for testing). Contract:
 * - `ready` is sent ONLY after the SDK session starts successfully.
 * - If session creation rejects, the socket gets one `error` and is closed
 *   (1011) so the UI can never appear connected; the half-open ChatSession
 *   is disposed and further messages get a "session failed" error.
 */
export function createConnectionHandler({ cwd, deps = defaultDeps }: ConnectionOptions) {
	return (ws: WebSocket): void => {
	let closed = false;
	let started = false;
	let startFailed = false;
	const send = (msg: ServerMessage): void => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			// best effort on a dying socket
		}
	};

	const chat = new ChatSession(send);
	chat
		.start(cwd, deps)
		.then(() => {
			if (closed) return;
			started = true;
			send({ type: "ready", model: null });
		})
		.catch((err: unknown) => {
			startFailed = true;
			chat.dispose();
			if (closed) return;
			send({
				type: "error",
				message: `failed to start session: ${err instanceof Error ? err.message : String(err)}`,
			});
			try {
				ws.close(1011, "session start failed");
			} catch {
				// already closing
			}
		});

	ws.on("error", () => {
		try {
			ws.close();
		} catch {
			// already closing
		}
	});

	ws.on("message", (data: RawData) => {
		if (!started) {
			// Never buffer prompts for a session that does not exist yet:
		// a failed start must not look like a live (but silent) connection.
			send({
				type: "error",
				message: startFailed ? "session failed to start" : "session not ready",
			});
			return;
		}
		let raw: string;
		try {
			raw = data.toString();
		} catch {
			return;
		}
		if (raw.length > MAX_TEXT_BYTES) {
			send({ type: "error", message: "message too large" });
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			send({ type: "error", message: "invalid JSON message" });
			return;
		}
		// Shape gate: JSON null/strings/numbers must never reach `msg.type`
		// (`null.type` throws inside the listener and kills the socket).
		if (typeof parsed !== "object" || parsed === null) {
			send({ type: "error", message: "invalid message shape" });
			return;
		}
		const msg = parsed as ClientMessage;
		if (msg.type === "prompt") {
			if (typeof msg.text !== "string" || msg.text.trim().length === 0) {
				send({ type: "error", message: "prompt text must be non-empty" });
				return;
			}
			if (msg.text.length > MAX_TEXT_BYTES) {
				send({ type: "error", message: "prompt text too large" });
				return;
			}
			void chat.prompt(msg.text);
			return;
		}
		if (msg.type === "abort") {
			void chat.abort();
			return;
		}
		send({ type: "error", message: "unknown message type" });
	});

	ws.on("close", () => {
		closed = true;
		chat.dispose();
	});
	};
}

wss.on("connection", createConnectionHandler({ cwd: CWD }));

// Called by main.ts, never when tests import this module. Main-module path
// comparisons are unreliable under tsx (its loader changes import.meta.url).
export function startServer(): void {
	httpServer.listen(PORT, HOST, () => {
		console.log(`learn chat bridge on http://${HOST}:${PORT} (cwd: ${CWD})`);
	});
}
