import { describe, expect, it, vi } from "vitest";
import {
  ActiveProjectSchema,
  DashboardRequestSchema,
} from "../shared/bridge.js";
import {
  allowsMediaRequest,
  clampPosition,
  dashboardUrl,
  projectFromLink,
  registerShortcut,
  toggleWindow,
  serviceOrigin,
  rendererOrigin,
  isTrustedFrame,
  allowsIpcSender,
  allowsMediaCheck,
  overlaySize,
} from "./policy.js";

describe("desktop platform policy", () => {
  it("accepts only UUID/null selection and exact supported dashboard views", () => {
    const projectId = "bc812dea-31c8-4258-a81d-08c7eeb14b97";
    expect(ActiveProjectSchema.parse(null)).toBeNull();
    expect(ActiveProjectSchema.parse(projectId)).toBe(projectId);
    for (const value of ["", "../../secret", undefined, { projectId }])
      expect(ActiveProjectSchema.safeParse(value).success).toBe(false);
    for (const view of [
      "command",
      "merchants",
      "reality",
      "operations",
      "execution",
    ] as const)
      expect(dashboardUrl("https://molecule.example", projectId, view)).toBe(
        `https://molecule.example/projects/${projectId}?view=${view}`,
      );
    expect(
      DashboardRequestSchema.safeParse({ projectId, view: "https://evil" })
        .success,
    ).toBe(false);
    expect(
      DashboardRequestSchema.safeParse({ projectId, url: "https://evil" })
        .success,
    ).toBe(false);
    expect(() =>
      dashboardUrl("https://molecule.example", undefined, "execution"),
    ).toThrow("project");
  });
  it("focuses a visible dock behind another app, then hides on repeat activation", () => {
    let focused = false;
    const window = {
      isVisible: () => true,
      isFocused: () => focused,
      show: vi.fn(() => {
        focused = true;
      }),
      hide: vi.fn(),
    };
    toggleWindow(window);
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.hide).not.toHaveBeenCalled();
    toggleWindow(window);
    expect(window.hide).toHaveBeenCalledOnce();
  });
  it("fits every dock mode into a smaller or rotated display", () => {
    for (const mode of ["compact", "conversation", "company", "alert"]) {
      const area = { x: -320, y: 20, width: 320, height: 580 };
      const size = overlaySize(mode, area);
      const position = clampPosition({ x: 5000, y: 5000 }, size, area);
      expect(size.width).toBeLessThanOrEqual(area.width);
      expect(size.height).toBeLessThanOrEqual(area.height);
      expect(position.x + size.width).toBeLessThanOrEqual(area.x + area.width);
      expect(position.y + size.height).toBeLessThanOrEqual(
        area.y + area.height,
      );
    }
  });
  it.each([
    "https://user:secret@example.com",
    "http://example.com",
    "file:///secret",
    "https://example.com/?token=secret",
    "https://example.com/api",
    "javascript:alert(1)",
  ])("rejects unsafe service configuration %s", (url) => {
    expect(() => serviceOrigin(url)).toThrow();
    expect(() => dashboardUrl(url)).toThrow();
  });
  it("trusts only the configured main frame of this window", () => {
    const origin = rendererOrigin("http://127.0.0.1:5173");
    expect(
      allowsIpcSender(
        { id: 1, mainFrame: true, url: `${origin}/index.html` },
        1,
        origin,
      ),
    ).toBe(true);
    expect(
      allowsIpcSender({ id: 2, mainFrame: true, url: `${origin}/` }, 1, origin),
    ).toBe(false);
    expect(
      allowsIpcSender(
        { id: 1, mainFrame: false, url: `${origin}/` },
        1,
        origin,
      ),
    ).toBe(false);
    for (const url of [
      "http://127.0.0.1:51730/",
      "http://127.0.0.1:5173.evil/",
      "http://user:secret@127.0.0.1:5173/",
      "about:blank",
    ])
      expect(isTrustedFrame(url, origin)).toBe(false);
    expect(isTrustedFrame("app://molecule/index.html", rendererOrigin())).toBe(
      true,
    );
    expect(
      isTrustedFrame("app://molecule.evil/index.html", rendererOrigin()),
    ).toBe(false);
    expect(() => rendererOrigin("https://example.com")).toThrow();
    expect(() => rendererOrigin("ftp://localhost")).toThrow();
  });
  it("denies camera and unknown media checks without explicit screen selection", () => {
    expect(allowsMediaCheck("media", "video", true)).toBe(false);
    expect(allowsMediaCheck("media", "unknown", false)).toBe(false);
    expect(allowsMediaCheck("media", "audio", false)).toBe(true);
    expect(allowsMediaCheck("media", "unknown", true)).toBe(true);
    expect(allowsMediaCheck("geolocation", "audio", true)).toBe(false);
  });
  it("rejects malformed deep links and credentials", () => {
    const id = "bc812dea-31c8-4258-a81d-08c7eeb14b97";
    for (const url of [
      `molecule://user@project/${id}`,
      `molecule://project/${id}?next=evil`,
      `molecule://project/${"-".repeat(36)}`,
    ])
      expect(projectFromLink(url)).toBeNull();
  });
  it.each([
    ["media", [], true, true],
    ["media", [], false, false],
    ["media", undefined, true, false],
    ["media", ["audio"], false, true],
    ["media", ["video"], true, false],
    ["media", ["audio", "video"], true, false],
    ["display-capture", undefined, true, true],
    ["display-capture", undefined, false, false],
    ["geolocation", [], true, false],
  ] as const)(
    "gates %s (%j) with screen selection=%s",
    (permission, mediaTypes, selected, expected) => {
      expect(allowsMediaRequest(permission, mediaTypes, selected)).toBe(
        expected,
      );
    },
  );
  it("registers a toggle and falls back if Option+Space is owned", () => {
    const window = {
      isVisible: () => visible,
      show: vi.fn(() => {
        visible = true;
      }),
      hide: vi.fn(() => {
        visible = false;
      }),
    };
    let visible = false;
    let callback = () => undefined as void;
    const registry = {
      register: vi.fn((key: string, action: () => void) => {
        callback = action;
        return key !== "Alt+Space";
      }),
      unregister: vi.fn(),
    };
    expect(
      registerShortcut(registry, "Alt+Space", () => toggleWindow(window)),
    ).toBe("CommandOrControl+Shift+M");
    callback();
    expect(visible).toBe(true);
    callback();
    expect(visible).toBe(false);
  });
  it("opens only a fixed web origin and validated project path", () => {
    const id = "bc812dea-31c8-4258-a81d-08c7eeb14b97";
    expect(dashboardUrl("https://molecule.example", id)).toBe(
      `https://molecule.example/projects/${id}`,
    );
    expect(() => dashboardUrl("javascript:alert(1)")).toThrow();
    expect(projectFromLink(`molecule://project/${id}`)).toBe(id);
    expect(projectFromLink("molecule://project/../../secret")).toBeNull();
  });
  it("keeps a remembered position on the visible display", () => {
    expect(
      clampPosition(
        { x: -5000, y: 4000 },
        { width: 400, height: 600 },
        { x: 1920, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 1920, y: 480 });
  });
});
