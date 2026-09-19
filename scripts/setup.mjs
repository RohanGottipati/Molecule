import { spawnSync } from "node:child_process";

for (const [command, args] of [
  ["pnpm", ["install", "--frozen-lockfile"]],
  [
    "uv",
    ["venv", "--allow-existing", "--python", "3.12", "services/solver/.venv"],
  ],
  [
    "uv",
    [
      "pip",
      "install",
      "--python",
      "services/solver/.venv/bin/python",
      "-r",
      "services/solver/requirements-dev.txt",
    ],
  ],
  [
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=@molecule/orchestrator..."],
  ],
]) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
