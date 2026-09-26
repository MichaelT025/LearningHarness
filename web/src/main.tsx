import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import "./styles.css";
import "./css/shell.css";
import "./css/messages.css";
import "./css/composer.css";
import "./css/workspace.css";
import "./css/polish.css";
import "./css/minimap.css";
import "./css/workers.css";
import "./css/todos.css";
import "highlight.js/styles/github-dark.css";
import { initAuthToken } from "./auth-token";
import { installScrollbarGutterVar } from "./scrollbar-gutter";
import { appBase } from "./base-url";

// 吸收地址栏 ?token=（PI_WEB_TOKEN 鉴权入口）并持久化，须在首次请求前执行
initAuthToken();

// 首帧前实测滚动条宽（scrollbar-gutter 预留 gutter 的宽度）→ 宽屏消息列与
// 输入列的对齐补偿变量 --msgs-gutter，见 scrollbar-gutter.ts。
installScrollbarGutterVar();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<LanguageProvider>
			<App />
		</LanguageProvider>
	</StrictMode>,
);

// PWA: register the service worker only in production builds so the Vite dev
// server (live reload / HMR) is never intercepted or cached. The scope is
// derived from the page URL (appBase), so sub-path deployments like /pi/ get
// a worker scoped to the app root instead of the site root.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
	// Register after load so it never blocks first paint.
	window.addEventListener("load", () => {
		const base = appBase();
		navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err) => {
			console.warn("Service worker registration failed:", err);
		});
	});
}
