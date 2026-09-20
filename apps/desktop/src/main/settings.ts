import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SHORTCUT,
  LEGACY_DEFAULT_SHORTCUT,
  SettingsSchema,
  SettingsPatchSchema,
  type Settings,
  type SettingsPatch,
} from "../shared/bridge.js";

export class SettingsStore {
  private value = SettingsSchema.parse({});
  private writes = Promise.resolve();
  constructor(private readonly directory: string) {}

  async load() {
    try {
      const saved = SettingsSchema.parse(
        JSON.parse(
          await readFile(join(this.directory, "settings.json"), "utf8"),
        ),
      );
      if (saved.shortcut === LEGACY_DEFAULT_SHORTCUT) {
        await this.save({ ...saved, shortcut: DEFAULT_SHORTCUT });
        console.info(
          JSON.stringify({
            scope: "main",
            event: "settings.shortcut.migrated",
          }),
        );
      } else {
        this.value = saved;
      }
    } catch {
      console.info(
        JSON.stringify({ scope: "main", event: "settings.defaults" }),
      );
    }
    return this.value;
  }
  get() {
    return this.value;
  }
  save(value: Settings) {
    return this.update(SettingsSchema.parse(value));
  }
  update(value: SettingsPatch) {
    const patch = SettingsPatchSchema.parse(value);
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        const next = SettingsSchema.parse({ ...this.value, ...patch });
        const contents = JSON.stringify(next);
        await mkdir(this.directory, { recursive: true });
        await writeFile(join(this.directory, "settings.next"), contents, {
          mode: 0o600,
        });
        await rename(
          join(this.directory, "settings.next"),
          join(this.directory, "settings.json"),
        );
        this.value = next;
      });
    return this.writes;
  }
}
