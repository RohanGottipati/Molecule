import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CONTEXT_BYTES } from "@molecule/contracts";
import { pasteFiles } from "./context.js";

const readClipboard = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      { types: string[]; getType: (type: string) => Promise<Blob> }[]
    >
  >(),
);
vi.mock("electron", () => ({ clipboard: { read: readClipboard } }));
afterEach(() => vi.resetAllMocks());

describe("explicit clipboard context", () => {
  it("captures UTF-8 plain text without losing line breaks", async () => {
    const text = "Molecule résumé\nKeep the logo green.";
    readClipboard.mockResolvedValue([
      {
        types: ["text/plain"],
        getType: async () => new Blob([text], { type: "text/plain" }),
      },
    ]);
    const files = await pasteFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: "pasted-text.txt",
      mimeType: "text/plain",
    });
    expect(new TextDecoder().decode(files[0]?.bytes)).toBe(text);
  });
  it("prefers the image over its clipboard text representation", async () => {
    readClipboard.mockResolvedValue([
      {
        types: ["text/plain", "image/png"],
        getType: async (type) =>
          new Blob([type === "image/png" ? "image bytes" : "image caption"]),
      },
    ]);
    expect((await pasteFiles())[0]?.name).toBe("pasted-image.png");
  });
  it("does not turn an unsupported copied file into a text attachment", async () => {
    readClipboard.mockResolvedValue([
      {
        types: ["text/uri-list", "text/plain"],
        getType: async () => new Blob(["file:///document.xlsx"]),
      },
    ]);
    await expect(pasteFiles()).rejects.toThrow("isn’t supported");
  });
  it("rejects oversized text and empty or unsupported clipboard content", async () => {
    readClipboard.mockResolvedValue([
      {
        types: ["text/plain"],
        getType: async () => new Blob([new Uint8Array(MAX_CONTEXT_BYTES + 1)]),
      },
    ]);
    await expect(pasteFiles()).rejects.toThrow("exceeds 10 MB");
    readClipboard.mockResolvedValue([]);
    await expect(pasteFiles()).rejects.toThrow("Copy text");
    readClipboard.mockResolvedValue([
      { types: ["text/html"], getType: async () => new Blob(["<b>Text</b>"]) },
    ]);
    await expect(pasteFiles()).rejects.toThrow("Copy text");
  });
});
