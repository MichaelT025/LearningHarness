import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev: Vite serves the UI on :5173 and proxies /ws to the backend.
// Backend port defaults to 8788; override with LEARN_PORT to run
// side by side with another checkout.
const backendPort = Number(process.env.LEARN_PORT) || 8788;

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: join(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
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
