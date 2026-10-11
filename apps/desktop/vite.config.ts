import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and must not open a browser. Only VITE_-prefixed env vars are
// exposed to the webview bundle — never put secrets behind that prefix.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_"],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
