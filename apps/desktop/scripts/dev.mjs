import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";

await import("./build.mjs");
const server = await createServer();
await server.listen();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, DESKTOP_RENDERER_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
