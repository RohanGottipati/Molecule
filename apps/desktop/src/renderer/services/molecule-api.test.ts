import { afterEach, describe, expect, it, vi } from "vitest";
import { MoleculeApi, validateContext } from "./molecule-api.js";
import { projectResult } from "./test-fixtures.js";
import { ToolDispatcher } from "./tool-dispatcher.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("desktop commands", () => {
  it("calls browser fetch with its Window receiver", async () => {
    const transport = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        Response.json({
          demoMode: true,
          mockProviders: {},
          maxContextBytes: 10_485_760,
        }),
      );
    });
    vi.stubGlobal("fetch", transport);
    await new MoleculeApi("http://localhost:3001").config();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("retries a lost HTTP response with an identical action ID and request body", async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Network lost"))
      .mockResolvedValueOnce(Response.json(projectResult()));
    const request = new MoleculeApi("http://localhost:3001", transport).command(
      "project-1",
      { name: "cancel_project", args: {} },
      "fixed-id",
    );
    await vi.runAllTimersAsync();
    await request;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[1]?.body).toEqual(
      transport.mock.calls[1]?.[1]?.body,
    );
    expect(
      JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).actionId,
    ).toBe("fixed-id");
  });
  it("coalesces in-flight tool calls and rejects ID reuse with different arguments", async () => {
    const backend = vi.fn(async () => projectResult());
    const dispatcher = new ToolDispatcher(backend);
    await Promise.all([
      dispatcher.run("one", "cancel_project", "{}"),
      dispatcher.run("one", "cancel_project", "{}"),
    ]);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(() =>
      dispatcher.run("one", "start_project", '{"intent":"different"}'),
    ).toThrow("reused");
  });
  it("validates attachment types and sizes before upload", async () => {
    expect(validateContext(new File(["logo"], "logo.PNG"))).toBe("image/png");
    expect(() => validateContext(new File(["bad"], "program.exe"))).toThrow(
      "isn’t supported",
    );
    expect(() => validateContext(new File([], "empty.txt"))).toThrow("10 MB");
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        contextId: "bb812dea-31c8-4258-a81d-08c7eeb14b97",
        asset: {
          assetId: "bb812dea-31c8-4258-a81d-08c7eeb14b97",
          checksum: "a".repeat(64),
        },
      }),
    );
    const file = new File(["logo"], "logo.png");
    await new MoleculeApi("http://localhost:3001", transport).uploadContext(
      "project",
      file,
      "upload-id",
    );
    expect(transport.mock.calls[0]?.[1]?.body).toBe(file);
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Action-Id": "upload-id",
      "X-File-Type": "image/png",
    });
  });
});
