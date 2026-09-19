import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const python =
  process.env.SOLVER_PYTHON ?? resolve("services/solver/.venv/bin/python");
if (!existsSync(python)) {
  console.error(
    "Solver environment missing. Install uv, then run pnpm bootstrap.",
  );
  process.exit(1);
}
if (!existsSync("packages/contracts/dist/index.js")) {
  console.error("Workspace build missing. Run pnpm bootstrap.");
  process.exit(1);
}
const solver = new URL(process.env.SOLVER_URL ?? "http://127.0.0.1:8000");
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const [command, args] of [
  [
    python,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--app-dir",
      "services/solver",
      "--host",
      solver.hostname,
      "--port",
      solver.port || "8000",
    ],
  ],
  ["pnpm", ["--filter", "@molecule/orchestrator", "dev"]],
  [
    "pnpm",
    [
      "--filter",
      "@molecule/web",
      "dev",
      "--port",
      process.env.WEB_PORT ?? "3000",
    ],
  ],
]) {
  const child = spawn(command, args, {
    stdio: "inherit",
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
