import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The server serves the built client under /play/ (ADR-0006). In development,
// `pnpm --filter @positrontanks/web dev` proxies API paths to a local server.
const api = "http://127.0.0.1:8080";

export default defineConfig({
  base: "/play/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "^/(?!play(/|$))": { target: api },
    },
  },
});
