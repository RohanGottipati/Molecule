import { describe, expect, it } from "vitest";

import { MockOpenAIAdapter } from "./MockOpenAIAdapter.js";

const base = {
  orderId: "order-1",
  traceId: "trace-1",
  locale: "en-CA",
  timeZone: "America/Toronto",
  requestedAt: "2026-09-19T12:00:00.000Z",
  assets: [],
};

describe("MockOpenAIAdapter", () => {
  const initialFixtures = [
    ["Make 10 hoodies by 2026-10-01 CAD", 10, "CAD", "Hoodie"],
    ["Need 25 bottles by 2026-10-02 USD", 25, "USD", "Bottle"],
    ["Want 40 black hoodies by 2026-10-03 CAD", 40, "CAD", "Hoodie"],
    ["Make 12 kits by 2026-10-04 CAD", 12, "CAD", "Onboarding kit"],
    ["Quantity 90 hoodies by 2026-10-05 USD", 90, "USD", "Hoodie"],
    ["Need 7 bottles engraved by 2026-10-06 CAD", 7, "CAD", "Bottle"],
    ["Want 61 hoodies embroidered by 2026-10-07 CAD", 61, "CAD", "Hoodie"],
    ["Make 100 bottles by 2026-10-08 USD", 100, "USD", "Bottle"],
    ["Qty 18 kits by 2026-10-09 CAD", 18, "CAD", "Onboarding kit"],
    ["Need 33 hoodies by 2026-10-10 CAD under $900", 33, "CAD", "Hoodie"],
    ["Make 5 hoodies by 2026-11-01 CAD", 5, "CAD", "Hoodie"],
    ["I want 6 bottles by 2026-11-02 USD", 6, "USD", "Bottle"],
    ["Need 14 kits by 2026-11-03 CAD", 14, "CAD", "Onboarding kit"],
    ["Qty 16 black hoodies by 2026-11-04 USD", 16, "USD", "Hoodie"],
    ["Quantity of 17 bottles by 2026-11-05 CAD", 17, "CAD", "Bottle"],
    ["Make 21 bottles engraved by 2026-11-06 USD", 21, "USD", "Bottle"],
    ["Want 24 hoodies embroidered by 2026-11-07 CAD", 24, "CAD", "Hoodie"],
    ["Need 26 kits by 2026-11-08 USD", 26, "USD", "Onboarding kit"],
    ["Make 31 hoodies by 2026-11-09 CAD under $1200", 31, "CAD", "Hoodie"],
    ["Want 44 bottles by 2026-11-10 USD under $2200", 44, "USD", "Bottle"],
  ] as const;

  it.each(initialFixtures)(
    "validates initial fixture: %s",
    async (text, quantity, currency, output) => {
      const result = await new MockOpenAIAdapter().compileIntent({
        ...base,
        text,
      });
      expect(result.status).toBe("READY");
      if (result.status === "READY") {
        expect(result.intent.quantity).toBe(quantity);
        expect(result.intent.currency).toBe(currency);
        expect(result.intent.desiredOutputs.map(({ name }) => name)).toContain(
          output,
        );
      }
    },
  );

  it("compiles a complete request", async () => {
    const adapter = new MockOpenAIAdapter();
    const result = await adapter.compileIntent({
      ...base,
      text: "Make 50 black hoodies with embroidery by 2026-10-01 under $3000 CAD, no polyester",
    });

    expect(result.status).toBe("READY");
    if (result.status === "READY") {
      expect(result.intent.quantity).toBe(50);
      expect(result.intent.hardConstraints).toContainEqual(
        expect.objectContaining({ field: "material", value: "polyester" }),
      );
    }
  });

  it("accepts natural currency phrasing as a recognised clause", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Order 50 black hoodies with embroidered logo, deliver by 2026-11-15, priced in CAD, budget 3000 CAD",
    });

    expect(result.status).toBe("READY");
    if (result.status === "READY") {
      expect(result.intent.quantity).toBe(50);
      expect(result.intent.currency).toBe("CAD");
      expect(result.intent.budgetMax).toBe(3000);
    }
  });

  it("surfaces missing facts instead of inventing them", async () => {
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "I want embroidered hoodies",
    });

    expect(result.status).toBe("NEEDS_CLARIFICATION");
    if (result.status === "NEEDS_CLARIFICATION") {
      expect(result.draft.quantity).toBeNull();
      expect(result.questions).toHaveLength(3);
    }
  });

  it("preserves provided image and file references without inventing URLs", async () => {
    const assets = [
      {
        assetId: "logo",
        name: "logo.png",
        mimeType: "image/png",
        url: "https://assets.example.test/logo.png",
      },
      {
        assetId: "spec",
        name: "spec.pdf",
        mimeType: "application/pdf",
        checksum: "sha256:test",
      },
    ];
    const result = await new MockOpenAIAdapter().compileIntent({
      ...base,
      text: "Make 10 embroidered hoodies by 2026-12-01 CAD",
      assets,
    });
    expect(result.status).toBe("READY");
    if (result.status === "READY") expect(result.intent.assets).toEqual(assets);
  });

  it("increments the version and preserves unaffected fields on correction", async () => {
    const adapter = new MockOpenAIAdapter();
    const first = await adapter.compileIntent({
      ...base,
      text: "Make 20 hoodies by 2026-10-01 CAD",
    });
    expect(first.status).toBe("READY");
    if (first.status !== "READY") return;

    const corrected = await adapter.compileIntent({
      ...base,
      text: "Actually make 30 hoodies and no polyester",
      previousIntent: {
        ...first.intent,
        budgetMax: first.intent.budgetMax ?? null,
      },
      correction: { kind: "quantity", text: "Actually make 30" },
    });

    expect(corrected.status).toBe("READY");
    if (corrected.status === "READY") {
      expect(corrected.intent.version).toBe(2);
      expect(corrected.intent.deadline).toBe(first.intent.deadline);
      expect(corrected.intent.quantity).toBe(30);
    }
  });

  it("retains the budget and attached context when a correction mentions budget followed by punctuation", async () => {
    const adapter = new MockOpenAIAdapter();
    const initial = await adapter.compileIntent({
      ...base,
      text: "Make 200 black hoodies by 2026-10-01 under $7,000 CAD, no leather",
    });
    expect(initial.status).toBe("READY");
    if (initial.status !== "READY") return;

    const assets = [
      {
        assetId: "brand-context",
        name: "brand-context.txt",
        mimeType: "text/plain",
        checksum: "sha256:context",
      },
    ];
    const text =
      "Use the attached brand-context.txt for the hoodie logo. Keep the current 200 kits, deadline, CAD 7,000 budget, no leather and no polyester requirements.";
    const corrected = await adapter.compileIntent({
      ...base,
      assets,
      text,
      correction: { kind: "other", text },
      previousIntent: initial.intent,
    });
    expect(corrected.status).not.toBe("UNSUPPORTED");
    if (corrected.status === "UNSUPPORTED") return;
    const intent =
      corrected.status === "READY" ? corrected.intent : corrected.draft;
    expect(intent.budgetMax).toBe(7000);
    expect(intent.quantity).toBe(200);
    expect(intent.deadline).toBe(initial.intent.deadline);
    expect(intent.assets).toEqual(assets);
    expect(intent.hardConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "material", value: "leather" }),
        expect.objectContaining({ field: "material", value: "polyester" }),
      ]),
    );
  });

  it("validates five correction fixtures without losing known facts", async () => {
    const adapter = new MockOpenAIAdapter();
    const initial = await adapter.compileIntent({
      ...base,
      text: "Make 20 embroidered hoodies by 2026-10-01 under $1000 CAD",
    });
    expect(initial.status).toBe("READY");
    if (initial.status !== "READY") return;

    const corrections = [
      [
        "Make 30 hoodies instead",
        "quantity",
        30,
        "2026-10-01T23:59:59.000Z",
        1000,
      ],
      [
        "Keep 20 hoodies but deliver by 2026-10-12",
        "deadline",
        20,
        "2026-10-12T23:59:59.000Z",
        1000,
      ],
      [
        "Keep 20 hoodies and budget under $1500",
        "budget",
        20,
        "2026-10-01T23:59:59.000Z",
        1500,
      ],
      [
        "Make 45 hoodies with no polyester",
        "constraint",
        45,
        "2026-10-01T23:59:59.000Z",
        1000,
      ],
      ["Make 22 hoodies in USD", "other", 22, "2026-10-01T23:59:59.000Z", 1000],
    ] as const;

    for (const [text, kind, quantity, deadline, budget] of corrections) {
      const corrected = await adapter.compileIntent({
        ...base,
        text,
        previousIntent: {
          ...initial.intent,
          budgetMax: initial.intent.budgetMax ?? null,
        },
        correction: { kind, text },
      });
      expect(corrected.status).toBe("READY");
      if (corrected.status === "READY") {
        expect(corrected.intent.version).toBe(2);
        expect(corrected.intent.quantity).toBe(quantity);
        expect(corrected.intent.deadline).toBe(deadline);
        expect(corrected.intent.budgetMax).toBe(budget);
        expect(corrected.intent.desiredOutputs[0]?.name).toBe("Hoodie");
      }
    }
  });
});
