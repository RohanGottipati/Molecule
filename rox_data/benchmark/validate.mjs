#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateBundle, verifyRawFiles } from "./schema.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const allowed = new Set([
  "manifest",
  "reviewer-a",
  "reviewer-b",
  "adjudicated",
  "raw",
]);
if (
  Object.keys(args).some((key) => !allowed.has(key)) ||
  [...allowed].some((key) => !args[key])
)
  throw new Error(
    "Required: --manifest=<json> --reviewer-a=<json> --reviewer-b=<json> --adjudicated=<json> --raw=<private directory>",
  );

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const manifest = await json(args.manifest);
const reviewers = [
  await json(args["reviewer-a"]),
  await json(args["reviewer-b"]),
];
const adjudicated = await json(args.adjudicated);
const bundle = validateBundle({ manifest, reviewers, adjudicated });
const files = await verifyRawFiles(manifest, args.raw);
console.log(JSON.stringify({ valid: true, ...bundle, ...files }, null, 2));
