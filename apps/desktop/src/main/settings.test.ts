import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_SHORTCUT, LEGACY_DEFAULT_SHORTCUT } from "../shared/bridge.js";
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

it("merges concurrent preference, position and resume writes without losing fields", async () => {
  const path = await directory();
  const store = new SettingsStore(path);
  const projectId = "bb812dea-31c8-4258-a81d-08c7eeb14b97";
  await Promise.all([
    store.update({ voiceEnabled: false }),
    store.update({ position: { x: 120, y: 240 } }),
    store.update({ lastProjectId: projectId }),
    store.update({ notificationsEnabled: true }),
  ]);
  expect(await new SettingsStore(path).load()).toMatchObject({
    voiceEnabled: false,
    notificationsEnabled: true,
    position: { x: 120, y: 240 },
    lastProjectId: projectId,
  });
});

it("migrates the previous default shortcut without replacing custom shortcuts", async () => {
  const legacyPath = await directory();
  await writeFile(
    join(legacyPath, "settings.json"),
    JSON.stringify({ shortcut: LEGACY_DEFAULT_SHORTCUT }),
  );
  expect((await new SettingsStore(legacyPath).load()).shortcut).toBe(
    DEFAULT_SHORTCUT,
  );
  expect(
    JSON.parse(await readFile(join(legacyPath, "settings.json"), "utf8"))
      .shortcut,
  ).toBe(DEFAULT_SHORTCUT);

  const customPath = await directory();
  await writeFile(
    join(customPath, "settings.json"),
    JSON.stringify({ shortcut: "CommandOrControl+K" }),
  );
  expect((await new SettingsStore(customPath).load()).shortcut).toBe(
    "CommandOrControl+K",
  );
});
