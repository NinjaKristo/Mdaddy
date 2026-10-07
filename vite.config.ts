import { defineConfig } from "vite";
import stripCjk from "./scripts/strip-cjk";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  plugins: [stripCjk()],
  // v0.5.0 portable prefs use top-level await (load Data/settings.json before boot);
  // the default target (chrome87) lacks TLA. WebView2 = Chromium 100+, so es2022 is safe.
  build: { target: "es2022" },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
