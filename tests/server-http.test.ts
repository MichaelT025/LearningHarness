/**
 * Phase-0 HTTP/WS plumbing tests: static-file resolution and the WS
 * connection failure contract (no fake-connected UI, disposal on failure).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
	createConnectionHandler,
	originAllowed,
	resolveStaticFile,
	resolveWebDist,
} from "../server/index.js";
import type { ServerMessage } from "../server/protocol.js";
import type { SdkSessionLike } from "../server/chat-session.js";

function makeWebRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "learn-web-"));
	writeFileSync(join(root, "index.html"), "<html></html>");
	mkdirSync(join(root, "assets"), { recursive: true });
	writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
	return root;
}

/** Minimal fake socket capturing the handler's view of a WebSocket. */
function makeFakeSocket() {
	const messageHandlers: Array<(data: unknown) => void> = [];
	const closeHandlers: Array<() => void> = [];
	const sent: string[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		send: vi.fn((data: string) => {
			sent.push(data);
		}),
		close: vi.fn((_code?: number, _reason?: string) => {
			for (const h of closeHandlers) h();
		}),
		on: vi.fn((event: string, handler: (...args: never[]) => void) => {
			if (event === "message") messageHandlers.push(handler as never);
			if (event === "close") closeHandlers.push(handler as never);
		}),
		emitMessage: (data: unknown) => {
			for (const h of messageHandlers) h(data);
		},
		sentMessages: (): ServerMessage[] => sent.map((s) => JSON.parse(s) as ServerMessage),
	};
	return socket;
}

/**
 * Isolated fake repo root: works on a clean checkout with no build artifacts
 * (never touches the real ./web/dist).
 */
function makeLayoutRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "learn-layout-"));
	mkdirSync(join(root, "server"), { recursive: true });
	mkdirSync(join(root, "dist", "server"), { recursive: true });
	mkdirSync(join(root, "web", "dist"), { recursive: true });
	writeFileSync(join(root, "web", "dist", "index.html"), "<html></html>");
	return root;
}

describe("resolveWebDist", () => {
	it("finds <dir>/../web/dist in tsx-dev layout", () => {
		const root = makeLayoutRoot();
		expect(resolveWebDist(join(root, "server"))).toBe(join(root, "web", "dist"));
	});

	it("finds <dir>/../../web/dist in compiled dist/server layout", () => {
		const root = makeLayoutRoot();
		expect(resolveWebDist(join(root, "dist", "server"))).toBe(join(root, "web", "dist"));
	});

	it("honors LEARN_WEB_DIST override", () => {
		const custom = mkdtempSync(join(tmpdir(), "learn-custom-"));
		const prev = process.env.LEARN_WEB_DIST;
		process.env.LEARN_WEB_DIST = custom;
		try {
			expect(resolveWebDist(join(tmpdir(), "nowhere"))).toBe(custom);
		} finally {
			if (prev === undefined) delete process.env.LEARN_WEB_DIST;
			else process.env.LEARN_WEB_DIST = prev;
		}
	});

	it("returns null when no layout exists anywhere", () => {
		const empty = mkdtempSync(join(tmpdir(), "learn-empty-"));
		const prevEnv = process.env.LEARN_WEB_DIST;
		const prevCwd = process.cwd();
		// Neutralize every fallback: override points at nothing, cwd has no
		// web/dist, and fromDir's ancestors have none either.
		process.env.LEARN_WEB_DIST = join(empty, "missing");
		process.chdir(empty);
		try {
			expect(resolveWebDist(join(empty, "a", "b"))).toBeNull();
		} finally {
			process.chdir(prevCwd);
			if (prevEnv === undefined) delete process.env.LEARN_WEB_DIST;
			else process.env.LEARN_WEB_DIST = prevEnv;
		}
	});
});

describe("originAllowed", () => {
	const req = (host: string, origin?: string): IncomingMessage =>
		({
			headers: origin === undefined ? { host } : { host, origin },
		}) as IncomingMessage;

	it("admits loopback Hosts without Origin (non-browser clients)", () => {
		expect(originAllowed(req("127.0.0.1:8788"))).toBe(true);
		expect(originAllowed(req("localhost:5173"))).toBe(true);
		expect(originAllowed(req("[::1]:8788"))).toBe(true);
	});

	it("admits same-authority loopback browser origins", () => {
		expect(originAllowed(req("127.0.0.1:8788", "http://127.0.0.1:8788"))).toBe(true);
		// Vite dev proxy: page and proxy Host share localhost:5173.
		expect(originAllowed(req("localhost:5173", "http://localhost:5173"))).toBe(true);
		expect(originAllowed(req("[::1]:8788", "http://[::1]:8788"))).toBe(true);
	});

	it("rejects DNS-rebinding hostnames even when Host and Origin match", () => {
		expect(originAllowed(req("evil.example:8788", "http://evil.example:8788"))).toBe(false);
		expect(originAllowed(req("evil.example"))).toBe(false);
		expect(originAllowed(req("127.0.0.1.evil.example:8788", "http://127.0.0.1.evil.example:8788"))).toBe(false);
	});

	it("rejects cross-authority and opaque origins", () => {
		// Dev page hitting the backend directly (no proxy) is cross-origin.
		expect(originAllowed(req("127.0.0.1:8788", "http://localhost:5173"))).toBe(false);
		expect(originAllowed(req("localhost:5173", "http://localhost:5174"))).toBe(false);
		expect(originAllowed(req("127.0.0.1:8788", "null"))).toBe(false);
		expect(originAllowed(req("127.0.0.1:8788", "file:///etc/passwd"))).toBe(false);
		expect(originAllowed(req("127.0.0.1:8788", "ws://127.0.0.1:8788"))).toBe(false);
		expect(originAllowed(req("127.0.0.1:8788", "not a url"))).toBe(false);
		expect(originAllowed(req(""))).toBe(false);
	});
});

describe("resolveStaticFile", () => {
	it("serves existing files and the SPA index", () => {
		const root = makeWebRoot();
		expect(resolveStaticFile(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
		expect(resolveStaticFile(root, "/")).toBe(join(root, "index.html"));
		expect(resolveStaticFile(root, "/some/route")).toBe(join(root, "index.html"));
	});

	it("rejects ../ traversal outside the root", () => {
		const root = makeWebRoot();
		expect(resolveStaticFile(root, "/../secret.txt")).toBeNull();
		expect(resolveStaticFile(root, "/assets/../../secret.txt")).toBeNull();
		expect(resolveStaticFile(root, "/%2e%2e/secret.txt")).toBeNull();
	});

	it("404s missing assets and /api/* instead of SPA fallback", () => {
		const root = makeWebRoot();
		expect(resolveStaticFile(root, "/assets/missing-abc123.js")).toBeNull();
		expect(resolveStaticFile(root, "/favicon.ico")).toBeNull();
		expect(resolveStaticFile(root, "/api/health")).toBeNull();
	});
});

describe("createConnectionHandler start failure", () => {
	it("sends error, closes the socket, sends no ready, and disposes", async () => {
		const deps = {
			createSession: async (): Promise<SdkSessionLike> => {
				throw new Error("no model configured");
			},
		};
		const handler = createConnectionHandler({ cwd: "/tmp", deps });
		const socket = makeFakeSocket();
		handler(socket as never);

		await new Promise((r) => setTimeout(r, 0));
		const msgs = socket.sentMessages();
		expect(msgs.length).toBe(1);
		expect(msgs[0]).toEqual({
			type: "error",
			message: "failed to start session: no model configured",
		});
		expect(socket.close).toHaveBeenCalledWith(1011, "session start failed");
		expect(msgs.some((m) => m.type === "ready")).toBe(false);

		// The socket is closed, so late prompts are dropped entirely — never
		// buffered into a dead session and never answered as if live.
		socket.emitMessage(JSON.stringify({ type: "prompt", text: "hi" }));
		expect(socket.sentMessages()).toHaveLength(1);

		// If the close handshake never completes (half-open socket), late
		// prompts are explicitly refused instead of buffering silently.
		const lingering = makeFakeSocket();
		lingering.close = vi.fn(); // close never lands; socket stays OPEN
		handler(lingering as never);
		await new Promise((r) => setTimeout(r, 0));
		lingering.emitMessage(JSON.stringify({ type: "prompt", text: "hi" }));
		expect(lingering.sentMessages().at(-1)).toEqual({
			type: "error",
			message: "session failed to start",
		});
	});

	it("null and non-object payloads get shape errors and never crash the server", async () => {
		const fakeSession: SdkSessionLike = {
			subscribe: () => () => {},
			prompt: vi.fn(async () => {}),
			abort: async () => {},
			dispose: () => {},
			getLastAssistantText: () => "ok",
		};
		const handler = createConnectionHandler({
			cwd: "/tmp",
			deps: { createSession: async () => fakeSession },
		});
		const socket = makeFakeSocket();
		handler(socket as never);
		await new Promise((r) => setTimeout(r, 0));
		expect(socket.sentMessages()).toEqual([{ type: "ready", model: null }]);

		for (const bad of ["null", "42", '"hi"', "[1,2]", "{}", "[]"]) {
			socket.emitMessage(bad);
		}
		const msgs = socket.sentMessages().slice(1);
		expect(msgs).toEqual([
			{ type: "error", message: "invalid message shape" }, // null
			{ type: "error", message: "invalid message shape" }, // 42
			{ type: "error", message: "invalid message shape" }, // "hi"
			{ type: "error", message: "unknown message type" }, // [1,2]
			{ type: "error", message: "unknown message type" }, // {}
			{ type: "error", message: "unknown message type" }, // []
		]);
		// The socket survives: a later valid prompt still flows through.
		socket.emitMessage(JSON.stringify({ type: "prompt", text: "alive?" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(fakeSession.prompt).toHaveBeenCalledWith("alive?");
		expect(socket.sentMessages().at(-1)).toEqual({ type: "done", text: "ok" });
	});

	it("buffers nothing before ready: pre-start prompts get not-ready error", async () => {
		let release: (s: SdkSessionLike) => void = () => {};
		const pending = new Promise<SdkSessionLike>((resolve) => {
			release = resolve;
		});
		const fakeSession: SdkSessionLike = {
			subscribe: () => () => {},
			prompt: vi.fn(),
			abort: async () => {},
			dispose: () => {},
			getLastAssistantText: () => "",
		};
		const deps = {
			createSession: () => pending,
		};
		const handler = createConnectionHandler({ cwd: "/tmp", deps });
		const socket = makeFakeSocket();
		handler(socket as never);

		socket.emitMessage(JSON.stringify({ type: "prompt", text: "early" }));
		expect(socket.sentMessages()).toEqual([{ type: "error", message: "session not ready" }]);
		expect(fakeSession.prompt).not.toHaveBeenCalled();

		release(fakeSession);
		await new Promise((r) => setTimeout(r, 0));
		expect(socket.sentMessages().at(-1)).toEqual({ type: "ready", model: null });
		// Now prompts flow through.
		socket.emitMessage(JSON.stringify({ type: "prompt", text: "late" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(fakeSession.prompt).toHaveBeenCalledWith("late");
	});
});
