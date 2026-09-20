import { afterEach, expect, it, vi } from "vitest";
import { readDemoConfiguration, type DemoConfiguration } from "./configuration";

afterEach(() => vi.unstubAllGlobals());

it("disables demo recovery immediately on refresh and keeps it disabled after failure", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ demoMode: true }))
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  const states: DemoConfiguration[] = [];
  await readDemoConfiguration((state) => states.push(state));
  expect(states.at(-1)?.enabled).toBe(true);
  await readDemoConfiguration((state) => states.push(state));
  expect(states.slice(2)).toEqual([
    { enabled: false, loading: true, error: null },
    {
      enabled: false,
      loading: false,
      error: expect.stringContaining("disabled"),
    },
  ]);
});
