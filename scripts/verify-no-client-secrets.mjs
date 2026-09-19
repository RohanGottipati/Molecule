import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const forbidden = [
  ["browser OpenAI env", /NEXT_PUBLIC_OPENAI_API_KEY/],
  [
    "OpenAI API key",
    /(?:\bsk-[A-Za-z0-9]{48}\b|\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,})/,
  ],
];
const roots = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/web/.next/static",
  "apps/desktop/src/renderer",
  "apps/desktop/src/preload",
  "apps/desktop/dist/renderer",
  "apps/desktop/dist/preload",
];
const findings = [];

async function scan(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await scan(target);
    else {
      const content = await readFile(target, "utf8").catch(() => "");
      for (const [label, pattern] of forbidden)
        if (pattern.test(content)) findings.push(`${target}:${label}`);
    }
  }
}

for (const root of roots) await scan(root);
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("client-secret scan passed");
}
