import {
  clipboard,
  desktopCapturer,
  session,
  systemPreferences,
  webContents,
  type DesktopCapturerSource,
} from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CONTEXT_BYTES } from "@molecule/contracts";
import type { CapturedFile } from "../shared/bridge.js";

export class ScreenContext {
  private sources = new Map<string, DesktopCapturerSource>();
  private selected?: { source: DesktopCapturerSource; expires: number };
  constructor(trustedFrame: (url: string) => boolean, webContentsId: number) {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        const selected = this.selected;
        this.selected = undefined;
        if (
          !selected ||
          selected.expires < Date.now() ||
          !request.frame ||
          request.frame.top !== request.frame ||
          webContents.fromFrame(request.frame)?.id !== webContentsId ||
          !trustedFrame(request.frame.url) ||
          request.audioRequested ||
          !request.videoRequested
        )
          return callback({});
        callback({ video: selected.source });
      },
    );
    this.webContentsId = webContentsId;
  }
  private readonly webContentsId: number;
  hasSelection() {
    return this.selected !== undefined && this.selected.expires >= Date.now();
  }
  async list() {
    if (
      process.platform === "darwin" &&
      ["denied", "restricted"].includes(
        systemPreferences.getMediaAccessStatus("screen"),
      )
    )
      throw new Error("Screen context requires Screen Recording permission.");
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    this.sources = new Map(sources.map((source) => [source.id, source]));
    console.info(
      JSON.stringify({
        scope: "main",
        event: "screen.sources.requested",
        webContentsId: this.webContentsId,
      }),
    );
    return sources.map(({ id, name }) => ({ id, name }));
  }
  select(id: string) {
    const source = this.sources.get(id);
    if (!source) throw new Error("Choose a current screen or window source");
    this.selected = { source, expires: Date.now() + 30_000 };
    this.sources.clear();
  }
}

export async function pasteFiles(): Promise<CapturedFile[]> {
  const items = await clipboard.read();
  const urls: string[] = [];
  let text: Blob | undefined;
  for (const item of items) {
    if (item.types.includes("image/png")) {
      const blob = await item.getType("image/png");
      if (!(blob instanceof Blob)) continue;
      if (blob.size > MAX_CONTEXT_BYTES)
        throw new Error("Clipboard image exceeds 10 MB");
      return [
        {
          name: "pasted-image.png",
          mimeType: "image/png",
          bytes: new Uint8Array(await blob.arrayBuffer()),
        },
      ];
    }
    if (!text && item.types.includes("text/plain")) {
      const blob = await item.getType("text/plain");
      if (blob instanceof Blob) text = blob;
    }
    const format = item.types.find(
      (type) =>
        type === 'electron application/osclipboard;format="public.file-url"' ||
        type === "text/uri-list",
    );
    if (!format) continue;
    const blob = await item.getType(format);
    if (blob instanceof Blob)
      urls.push(
        ...(await blob.text())
          .split(/[\r\n\0]+/)
          .filter((value) => value.startsWith("file://")),
      );
  }
  if (!urls.length) {
    if (!text?.size)
      throw new Error("Copy text, an image, or a supported file first.");
    if (text.size > MAX_CONTEXT_BYTES)
      throw new Error("Clipboard text exceeds 10 MB");
    return [
      {
        name: "pasted-text.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array(await text.arrayBuffer()),
      },
    ];
  }
  if (urls.length > 8) throw new Error("Paste up to eight files at a time");
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".json": "application/json",
  };
  return Promise.all(
    urls.map(async (url) => {
      const path = fileURLToPath(url);
      const mimeType = types[extname(path).toLowerCase()];
      if (!mimeType) throw new Error("That file type isn’t supported yet.");
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_CONTEXT_BYTES || info.size === 0)
        throw new Error("Choose a file between 1 byte and 10 MB.");
      return { name: basename(path), mimeType, bytes: await readFile(path) };
    }),
  );
}
