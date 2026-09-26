import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev: Vite serves the web UI on :5173 and proxies the WebSocket + any API
// traffic to the backend server (which runs separately via `npm run dev:server`).
// The dev backend is pinned to :8788 (see the dev:server script) so it never
// collides with a globally-installed pi-web-ui running on the default :8787.
// Override both with DISPATCH_DEV_PORT / PI_WEB_PORT to run a second checkout
// (e.g. a worktree) side by side.
const devPort = Number(process.env.DISPATCH_DEV_PORT) || 5173;
const backendPort = Number(process.env.LEARN_PORT) || 8788;
const backend = `http://127.0.0.1:${backendPort}`;
export default defineConfig({
	root: __dirname,
	plugins: [react()],
	build: {
		outDir: join(__dirname, "dist"),
		emptyOutDir: true,
		// 构建目标必须 ≥ es2021（逻辑赋值 ||= 的原生支持）。Vite 默认的
		// "modules"(=es2020) 会让 esbuild 降级 ||=，而 esbuild 降级 + 压缩写只写
		// 变量时会丢掉声明：`let r; f(r ||= {})` → `f(void 0 || (r = {}))`，严格模式
		// 下抛 ReferenceError。xterm 6 的 requestMode() 正是这个写法，被坑后 vim 等
		// 会发 DECRQM 查询的 TUI 一启动就把终端解析器打断，表现为“终端僵住、
		// 敲什么都没反应”。浏览器下限不变：||= 在 Chrome 85 / Safari 14 / FF 79 已支持。
		target: "es2022",
		rollupOptions: {
			output: {
				// 手动分包：大体积第三方库拆出主 chunk，利于浏览器缓存——
				// 业务代码变动时不让用户重新下载 xterm / markdown 渲染器
				manualChunks: {
					react: ["react", "react-dom"],
					markdown: [
						"react-markdown",
						"remark-gfm",
						"remark-math",
						"rehype-katex",
						"katex",
						"rehype-highlight",
						"highlight.js",
					],
					xterm: ["@xterm/xterm", "@xterm/addon-fit"],
				},
			},
		},
	},
	server: {
		port: devPort,
		strictPort: true,
		proxy: {
			"/api": backend,
			"/themes": backend,
			"/plugins": backend,
			"/ws": {
				target: `ws://127.0.0.1:${backendPort}`,
				ws: true,
				// Don't leak sockets when the backend is down/restarting (avoids
				// ERR_INSUFFICIENT_RESOURCES from accumulated dead proxy sockets).
				configure(proxy) {
					proxy.on("error", (_err, _req, socket) => {
						(socket as { destroy?: () => void } | undefined)?.destroy?.();
					});
					proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
						socket.on("error", () => {});
					});
				},
			},
		},
	},
});
