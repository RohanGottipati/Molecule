import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsSchema, type Settings } from "../shared/bridge.js";

export class SettingsStore {
  private value = SettingsSchema.parse({});
  private writes = Promise.resolve();
  constructor(private readonly directory: string) {}

  async load() {
    try {
      this.value = SettingsSchema.parse(
        JSON.parse(
          await readFile(join(this.directory, "settings.json"), "utf8"),
        ),
      );
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
    const next = SettingsSchema.parse(value);
    const contents = JSON.stringify(next);
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
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
