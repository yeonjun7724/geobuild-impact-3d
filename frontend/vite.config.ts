import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const CESIUM_BUILD = resolve(__dirname, "node_modules/cesium/Build/Cesium");
const API = process.env.VITE_API_PROXY ?? "http://127.0.0.1:8000";
const MIME: Record<string, string> = { ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".xml": "application/xml", ".ktx2": "image/ktx2" };

/** Self-hosted Cesium static assets at /cesium (Workers, Assets, ThirdParty, Widgets) - no Cesium ion / CDN. */
function cesiumAssets(): Plugin {
  return {
    name: "cesium-assets",
    configureServer(server) {
      server.middlewares.use("/cesium", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^[\\/]+/, "");
        const file = join(CESIUM_BUILD, rel);
        if (!file.startsWith(CESIUM_BUILD) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(opts) {
      const out = opts.dir ?? resolve(__dirname, "dist");
      for (const d of ["Workers", "ThirdParty", "Assets", "Widgets"]) cpSync(join(CESIUM_BUILD, d), join(out, "cesium", d), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cesiumAssets()],
  define: { CESIUM_BASE_URL: JSON.stringify("/cesium") },
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": { target: API, changeOrigin: true } } },
  preview: { port: 5173, host: "127.0.0.1", proxy: { "/api": { target: API, changeOrigin: true } } },
  build: { chunkSizeWarningLimit: 6000 },
});
