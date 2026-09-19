import { describe, expect, it, vi } from "vitest";
import {
  allowsMediaRequest,
  clampPosition,
  dashboardUrl,
  projectFromLink,
  registerShortcut,
  toggleWindow,
} from "./policy.js";

describe("desktop platform policy", () => {
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
