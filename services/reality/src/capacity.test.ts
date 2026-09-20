import { describe, expect, it } from "vitest";
import { applyCapacityLimit } from "./capacity.js";

describe("capacity evidence units", () => {
  it.each(["capacity", "capacity_per_day"] as const)(
    "aligns weekly availability and maximum with daily %s evidence",
    (field) => {
      expect(
        applyCapacityLimit(
          { available: 700, maximum: 1400, period: "week" },
          "units",
          field,
          80,
          "units/day",
        ),
      ).toEqual({
        ok: true,
        capacity: { available: 80, maximum: 200, period: "day" },
      });
    },
  );

  it("preserves a tighter existing rate when the fact uses another period", () => {
    expect(
      applyCapacityLimit(
        { available: 50, maximum: 100, period: "day" },
        "units",
        "capacity",
        700,
        "units/week",
      ),
    ).toEqual({
      ok: true,
      capacity: { available: 350, maximum: 700, period: "week" },
    });
  });

  it("retains explicit daily field semantics with legacy count-only units", () => {
    expect(
      applyCapacityLimit(
        { available: 700, period: "week" },
        "units",
        "capacity_per_day",
        80,
        "units",
      ),
    ).toEqual({ ok: true, capacity: { available: 80, period: "day" } });
  });

  it("does not invent a new period for legacy capacity or absolute inventory", () => {
    for (const field of ["capacity", "inventory"] as const) {
      expect(
        applyCapacityLimit(
          { available: 700, period: "week" },
          "units",
          field,
          80,
        ),
      ).toEqual({ ok: true, capacity: { available: 80, period: "week" } });
    }
  });

  it.each([
    ["capacity", "kg/day"],
    ["capacity", "units/month"],
    ["capacity", "units/day/week"],
    ["capacity_per_day", "units/week"],
    ["inventory", "units/day"],
  ] as const)("refuses incompatible %s units %s", (field, unit) => {
    expect(
      applyCapacityLimit(
        { available: 700, period: "week" },
        "units",
        field,
        80,
        unit,
      ).ok,
    ).toBe(false);
  });
});
