import { build } from "esbuild";

await build({
  entryPoints: ["src/main/index.ts", "src/preload/index.ts"],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outExtension: { ".js": ".cjs" },
});
