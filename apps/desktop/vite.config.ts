import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist/renderer" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
