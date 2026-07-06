import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const SERVER_PORT = process.env.OMP_DECK_PORT ?? "8787";
const SERVER_HOST = process.env.OMP_DECK_HOST ?? "127.0.0.1";
const WEB_PORT = Number(process.env.OMP_DECK_WEB_PORT ?? "5173");
// Set OMP_DECK_NO_MINIFY=1 (or run `bun run build:debug`) to produce an
// unminified build for debugging React/runtime errors.
const NO_MINIFY = !!process.env.OMP_DECK_NO_MINIFY;

const SERVER_HTTP = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_WS = `ws://${SERVER_HOST}:${SERVER_PORT}`;
export default defineConfig({
	plugins: [react(), tailwindcss()],
	// Expose `OMP_DECK_*` env vars (in addition to Vite's default `VITE_*`) so
	// power-user opt-outs like `OMP_DECK_CANVAS_SKIP_PREVIEW=1` are visible to
	// the client via `import.meta.env` without bouncing through a localStorage
	// shim.
	envPrefix: ["VITE_", "OMP_DECK_"],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		host: SERVER_HOST,
		port: WEB_PORT,
		proxy: {
			"/api": { target: SERVER_HTTP, changeOrigin: true },
			"/ws": { target: SERVER_WS, ws: true, changeOrigin: true },
		},
	},
	build: {
		outDir: "dist",
		sourcemap: true,
		...(NO_MINIFY && { minify: false }),
	},
});
