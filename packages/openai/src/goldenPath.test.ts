import { describe, expect, it, vi } from "vitest";
import {
  GOLDEN_PATH_CORRECTION,
  GOLDEN_PATH_PROMPT,
  ProductIntentSchema,
  type CompileIntentResult,
} from "@molecule/contracts";

import {
  GoldenPathOpenAIAdapter,
  goldenPathDeadline,
  goldenPathIntent,
  goldenPathIntentId,
} from "./goldenPath.js";
import { MockOpenAIAdapter } from "./MockOpenAIAdapter.js";
import type { OpenAIAdapter } from "./OpenAIAdapter.js";

const base = {
  orderId: "order-golden",
  traceId: "trace-golden",
  locale: "en-CA",
  timeZone: "America/Toronto",
  requestedAt: "2026-09-20T07:00:00.000Z",
  assets: [],
};

describe("golden path intent", () => {
  it("derives a stable RFC 4122 intent id per order", () => {
    const id = goldenPathIntentId("order-golden");
    expect(id).toBe(goldenPathIntentId("order-golden"));
    expect(id).not.toBe(goldenPathIntentId("order-other"));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ProductIntentSchema.shape.intentId.safeParse(id).success).toBe(true);
  });

  it("resolves next Friday to the coming Friday when it leaves 72 hours", () => {
    expect(
      goldenPathDeadline("2026-09-20T07:00:00.000Z", "America/Toronto"),
    ).toBe("2026-09-26T03:59:59.000Z");
  });

  it("skips to the following Friday when the coming one is too close", () => {
    expect(
      goldenPathDeadline("2026-09-24T12:00:00.000Z", "America/Toronto"),
    ).toBe("2026-10-03T03:59:59.000Z");
  });

  it("is a complete, unambiguous kit intent", () => {
    const intent = goldenPathIntent({
      orderId: "order-golden",
      requestedAt: base.requestedAt,
      timeZone: base.timeZone,
    });
    expect(intent.ambiguityFlags).toEqual([]);
    expect(intent.desiredOutputs.map((o) => o.outputId)).toEqual([
      "hoodie",
      "bottle",
      "snacks",
    ]);
    expect(intent.transformations.map((t) => t.kind)).toEqual([
      "embroidery",
      "engraving",
      "assembly",
      "fulfillment",
    ]);
    expect(intent.hardConstraints.map((c) => c.constraintId)).toEqual([
      "hoodie-color-black",
      "snacks-diet-vegan",
      "no-leather",
      "individual-packaging",
    ]);
  });

  it("carries the same requirements the heuristic mock would extract", async () => {
    const heuristic = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: GOLDEN_PATH_PROMPT,
    });
    expect(heuristic.status).toBe("READY");
    if (heuristic.status !== "READY") return;
    const golden = goldenPathIntent({
      orderId: base.orderId,
      requestedAt: base.requestedAt,
      timeZone: base.timeZone,
    });
    const shape = (intent: typeof golden) => ({
      quantity: intent.quantity,
      deadline: intent.deadline,
      currency: intent.currency,
      budgetMax: intent.budgetMax,
      outputs: intent.desiredOutputs.map((o) => [o.outputId, o.attributes]),
      transformations: intent.transformations.map((t) => [
        t.kind,
        t.inputRefs,
        t.outputRefs,
      ]),
      hard: intent.hardConstraints
        .map((c) => `${c.field} ${c.operator} ${c.value}`)
        .sort(),
      soft: intent.softPreferences.map(
        (c) => `${c.field} ${c.operator} ${c.value}`,
      ),
    });
    expect(shape(golden)).toEqual(shape(heuristic.intent));
  });
});

describe("GoldenPathOpenAIAdapter", () => {
  const compile = vi.fn<OpenAIAdapter["compileIntent"]>();
  const adapter = new GoldenPathOpenAIAdapter({ compileIntent: compile });

  it("answers the canonical brief without asking questions", async () => {
    compile.mockClear();
    const result = await adapter.compileIntent({
      ...base,
      text: `  ${GOLDEN_PATH_PROMPT.replace("7,000", "7000")}  `,
    });
    expect(result.status).toBe("READY");
    if (result.status !== "READY") return;
    expect(result.intent.intentId).toBe(goldenPathIntentId(base.orderId));
    expect(result.intent.version).toBe(1);
    expect(compile).not.toHaveBeenCalled();
  });

  it("keeps attached context on the compiled intent", async () => {
    const asset = {
      assetId: "asset-1",
      name: "logo.svg",
      mimeType: "image/svg+xml",
      url: "https://example.com/logo.svg",
    };
    const result = await adapter.compileIntent({
      ...base,
      text: GOLDEN_PATH_PROMPT,
      assets: [asset],
    });
    expect(result.status === "READY" && result.intent.assets).toEqual([asset]);
  });

  it("applies the canonical correction as a new intent version", async () => {
    compile.mockClear();
    const first = await adapter.compileIntent({
      ...base,
      text: GOLDEN_PATH_PROMPT,
    });
    if (first.status !== "READY") throw new Error("expected READY");
    const corrected = await adapter.compileIntent({
      ...base,
      text: GOLDEN_PATH_CORRECTION,
      correction: { kind: "constraint", text: GOLDEN_PATH_CORRECTION },
      previousIntent: { ...first.intent, budgetMax: null },
    });
    expect(corrected.status).toBe("READY");
    if (corrected.status !== "READY") return;
    expect(corrected.intent.version).toBe(2);
    expect(corrected.intent.intentId).toBe(first.intent.intentId);
    expect(corrected.intent.hardConstraints.at(-1)).toMatchObject({
      constraintId: "no-polyester",
      field: "material",
      operator: "not_contains",
      value: "polyester",
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it("delegates every other message to the wrapped adapter", async () => {
    const delegated: CompileIntentResult = {
      status: "UNSUPPORTED",
      reason: "delegated",
    };
    compile.mockReset();
    compile.mockResolvedValue(delegated);
    await expect(
      adapter.compileIntent({ ...base, text: "Make 200 hoodies" }),
    ).resolves.toEqual(delegated);
    const first = goldenPathIntent({
      orderId: base.orderId,
      requestedAt: base.requestedAt,
      timeZone: base.timeZone,
    });
    await expect(
      adapter.compileIntent({
        ...base,
        text: "Actually make it 250",
        previousIntent: first,
      }),
    ).resolves.toEqual(delegated);
    await expect(
      adapter.compileIntent({
        ...base,
        text: GOLDEN_PATH_CORRECTION,
        previousIntent: { ...first, intentId: goldenPathIntentId("other") },
      }),
    ).resolves.toEqual(delegated);
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it("only exposes optional capabilities the wrapped adapter provides", () => {
    expect(adapter.extractClaims).toBeUndefined();
    expect(adapter.mintRealtimeClientSecret).toBeUndefined();
    expect(adapter.uploadContext).toBeUndefined();
    const full = new GoldenPathOpenAIAdapter(new MockOpenAIAdapter());
    expect(full.extractClaims).toBeTypeOf("function");
  });
});
