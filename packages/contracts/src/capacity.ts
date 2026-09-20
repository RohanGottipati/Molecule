import type { MerchantCapability } from "./index.js";

type Capacity = MerchantCapability["capacity"];
type Period = NonNullable<Capacity["period"]>;
const PERIOD_HOURS: Record<Period, number> = { hour: 1, day: 24, week: 168 };
const canonicalUnit = (unit: string) => {
  const value = unit.trim().toLowerCase();
  return value === "unit" ? "units" : value;
};

/** Compare explicit capacity rates on the same time basis before applying a limit. */
export function applyCapacityLimit(
  current: Capacity,
  quantityUnit: string,
  field: "capacity" | "capacity_per_day" | "inventory",
  value: number,
  normalizedUnit?: string,
): { ok: true; capacity: Capacity } | { ok: false; reason: string } {
  let period: Period | undefined =
    field === "capacity_per_day" ? "day" : undefined;
  if (normalizedUnit !== undefined) {
    const [amountUnit, periodUnit, ...extra] = normalizedUnit
      .trim()
      .toLowerCase()
      .split("/");
    if (
      extra.length ||
      canonicalUnit(amountUnit ?? "") !== canonicalUnit(quantityUnit)
    )
      return {
        ok: false,
        reason: "Capacity quantity unit is unsupported or incompatible",
      };
    if (periodUnit !== undefined) {
      if (!Object.hasOwn(PERIOD_HOURS, periodUnit) || field === "inventory")
        return {
          ok: false,
          reason: "Capacity period is unsupported or incompatible",
        };
      if (period && period !== periodUnit)
        return {
          ok: false,
          reason: "Capacity period conflicts with its field",
        };
      period = periodUnit as Period;
    }
  }

  const factor =
    current.period && period
      ? PERIOD_HOURS[period] / PERIOD_HOURS[current.period]
      : 1;
  const available =
    current.available === undefined
      ? value
      : Math.min(current.available * factor, value);
  const maximum =
    current.maximum === undefined ? undefined : current.maximum * factor;
  if (
    !Number.isFinite(available) ||
    (maximum !== undefined && !Number.isFinite(maximum))
  )
    return {
      ok: false,
      reason: "Capacity conversion exceeds the numeric range",
    };
  return {
    ok: true,
    capacity: {
      ...current,
      available,
      ...(maximum === undefined ? {} : { maximum }),
      ...(period ? { period } : {}),
    },
  };
}
