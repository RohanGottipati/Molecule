import { describe, expect, it } from "vitest";
import { MockOpenAIAdapter } from "../../../packages/openai/src/MockOpenAIAdapter";
import {
  dockProjectHref,
  parseWorkspaceLocation,
  projectHref,
  relaxationDraft,
  shouldHandleNavigation,
} from "./navigation";

describe("workspace links", () => {
  it("retains view filters and round-trips encoded project identifiers", () => {
    const href = projectHref(
      "project with space",
      "merchants",
      "?merchant=one&search=abc&view=execution",
    );
    const url = new URL(href, "https://example.test");
    expect(url.searchParams.get("merchant")).toBe("one");
    expect(url.searchParams.get("search")).toBe("abc");
    expect(parseWorkspaceLocation(url.pathname, url.search)).toEqual({
      orderId: "project with space",
      view: "merchants",
    });
    expect(projectHref(null, "command", "?search=abc&view=execution")).toBe(
      "/?search=abc",
    );
    expect(parseWorkspaceLocation("/projects/%invalid", "?view=bad")).toEqual({
      orderId: null,
      view: "command",
    });
  });
  it("preserves browser modified clicks, middle clicks, downloads and external targets", () => {
    const click = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
    };
    expect(shouldHandleNavigation(click)).toBe(true);
    for (const key of [
      "metaKey",
      "ctrlKey",
      "shiftKey",
      "altKey",
      "defaultPrevented",
    ] as const)
      expect(shouldHandleNavigation({ ...click, [key]: true })).toBe(false);
    expect(shouldHandleNavigation({ ...click, button: 1 })).toBe(false);
    expect(shouldHandleNavigation(click, "_blank")).toBe(false);
    expect(shouldHandleNavigation(click, "_self", true)).toBe(false);
  });
  it("builds only the supported exact UUID dock route", () => {
    const id = "aabbccdd-1234-4234-9234-123456789abc";
    expect(dockProjectHref(id)).toBe(`molecule://project/${id}`);
    for (const value of [
      "project-one",
      `${id}?action=execute`,
      "../bad",
      "https://example.test",
    ])
      expect(dockProjectHref(value)).toBeUndefined();
  });
});

describe("safe relaxation drafts", () => {
  it("uses text the real demo compiler applies to the requested field", async () => {
    const adapter = new MockOpenAIAdapter();
    const request = {
      orderId: "one",
      traceId: "trace-one",
      locale: "en-CA",
      timeZone: "UTC",
      requestedAt: "2026-09-19T10:00:00Z",
      assets: [],
    };
    const initial = await adapter.compileIntent({
      ...request,
      text: "Make 20 hoodies by 2026-10-01 CAD budget 1000",
    });
    expect(initial.status).toBe("READY");
    if (initial.status !== "READY") throw new Error("Fixture did not compile");
    for (const [field, value] of [
      ["budgetMax", 8000],
      ["quantity", 100],
    ] as const) {
      const text = relaxationDraft(field, value)!;
      const result = await adapter.compileIntent({
        ...request,
        text,
        previousIntent: initial.intent,
      });
      expect(result.status).toBe("READY");
      if (result.status !== "READY")
        throw new Error("Relaxation did not compile");
      expect(result.intent[field]).toBe(value);
      expect(
        result.intent[field === "quantity" ? "budgetMax" : "quantity"],
      ).toBe(initial.intent[field === "quantity" ? "budgetMax" : "quantity"]);
    }
  });
  it("does not fabricate arbitrary-field, currency, invalid or rounded relaxations", () => {
    for (const value of ["8000", null, -1, 0, Infinity, NaN, 0.001, 1e21])
      expect(relaxationDraft("budgetMax", value)).toBeNull();
    expect(relaxationDraft("quantity", 1.5)).toBeNull();
    expect(relaxationDraft("budgetMax", 8000, "USD")).toBeNull();
    expect(relaxationDraft("polyester", 10)).toBeNull();
  });

  it.each([
    ["budgetMax", 125],
    ["quantity", 10],
  ] as const)(
    "compiles a reviewed %s draft with the correction payload used by the web",
    async (field, value) => {
      const adapter = new MockOpenAIAdapter();
      const request = {
        orderId: "one",
        traceId: "trace-one",
        requestedAt: "2026-09-19T10:00:00Z",
        locale: "en-CA",
        timeZone: "UTC",
        assets: [],
      };
      const initial = await adapter.compileIntent({
        ...request,
        text: "200 premium onboarding kits by Friday under CAD 100, black, no leather, logo on hoodie, engraved names on bottles, vegan snacks, individually packaged.",
      });
      expect(initial.status).toBe("READY");
      if (initial.status !== "READY")
        throw new Error("Fixture did not compile");
      const text = relaxationDraft(field, value)!;
      const result = await adapter.compileIntent({
        ...request,
        text,
        correction: { kind: "other", text },
        previousIntent: initial.intent,
      });
      expect(result.status).toBe("READY");
      if (result.status !== "READY")
        throw new Error("Reviewed relaxation did not compile");
      expect(result.intent[field]).toBe(value);
      expect(result.intent.deadline).toBe(initial.intent.deadline);
      expect(result.intent.transformations).toEqual(
        initial.intent.transformations,
      );
      expect(result.intent.hardConstraints).toEqual(
        initial.intent.hardConstraints,
      );
    },
  );
});
