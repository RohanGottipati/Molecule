import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "./settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(homedir(), ".molecule-settings-test-"));
  directories.push(path);
  return path;
}

it("serializes atomic settings writes and restores the committed value", async () => {
  const path = await directory();
  const store = new SettingsStore(path);
  const original = await store.load();
  await Promise.all([
    store.save({ ...original, microphoneDevice: "first" }),
    store.save({ ...original, microphoneDevice: "second" }),
  ]);
  expect(store.get().microphoneDevice).toBe("second");
  expect((await new SettingsStore(path).load()).microphoneDevice).toBe(
    "second",
  );
  expect(
    JSON.parse(await readFile(join(path, "settings.json"), "utf8"))
      .microphoneDevice,
  ).toBe("second");
  if (process.platform !== "win32")
    expect((await stat(join(path, "settings.json"))).mode & 0o777).toBe(0o600);
});

it("keeps the previous settings when persistence fails", async () => {
  const path = join(await directory(), "not-a-directory");
  await writeFile(path, "");
  const store = new SettingsStore(path);
  const original = store.get();
  await expect(
    store.save({ ...original, voiceEnabled: false }),
  ).rejects.toThrow();
  expect(store.get()).toEqual(original);
});

it("uses defaults after corrupt settings without crashing startup", async () => {
  const path = await directory();
  await writeFile(join(path, "settings.json"), "not json");
  const store = new SettingsStore(path);
  expect(await store.load()).toEqual(new SettingsStore(path).get());
});
