// Shared helpers for the private-bundle command line tools.
import { open, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function parseArgs(argv, allowed, required = []) {
  const args = Object.fromEntries(
    argv.map((a) => {
      const [key, ...rest] = a.replace(/^--/, "").split("=");
      return [key, rest.length ? rest.join("=") : "true"];
    }),
  );
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length)
    throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  const missing = required.filter((k) => !args[k]);
  if (missing.length)
    throw new Error(
      `Required: ${required.map((k) => `--${k}=<value>`).join(" ")}`,
    );
  return args;
}

export const readJson = async (path) =>
  JSON.parse(await readFile(path, "utf8"));

/** Private outputs (real labels, source-linked reports) must stay in the gitignored area. */
export function assertPrivatePath(path) {
  if (!resolve(path).split(sep).includes(".molecule-data"))
    throw new Error(
      `${path}: private output must live under a .molecule-data/ directory (gitignored)`,
    );
}

/** Exclusive create with owner-only permissions; existing files are never overwritten. */
export async function writeNew(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    );
  } finally {
    await handle.close();
  }
}
