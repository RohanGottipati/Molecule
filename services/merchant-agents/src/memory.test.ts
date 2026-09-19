import {
  createMerchantTwinService,
  InMemoryMerchantAgentRepository,
  MockBackboardAdapter,
} from "@molecule/backboard";
import { describe, expect, it } from "vitest";

import { createMerchantMemoryService } from "./memory.js";

describe("createMerchantMemoryService", () => {
  it("returns the sanitized fact and timestamp/source for a merchant, newest first", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const twin = createMerchantTwinService(adapter, repository);
    const memoryService = createMerchantMemoryService({ adapter, repository });

    await twin.ensureAssistant({
      merchantId: "stitchworks",
      displayName: "Stitchworks",
      specialty: "embroidery",
      boundaries: [],
    });
    await twin.ensureMerchantMemory({
      merchantId: "stitchworks",
      notes: ["First correction.", "Second correction."],
    });

    const entries = await memoryService.listMerchantMemory("stitchworks");

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.merchantId === "stitchworks")).toBe(
      true,
    );
    // Sanitized: only note/timestamp/source, never the internal assistantId.
    expect(entries[0]).not.toHaveProperty("assistantId");
    expect(new Set(entries.map((entry) => entry.note))).toEqual(
      new Set(["First correction.", "Second correction."]),
    );
  });

  it("returns an empty list rather than throwing for a merchant with no assistant yet", async () => {
    const adapter = new MockBackboardAdapter();
    const repository = new InMemoryMerchantAgentRepository();
    const memoryService = createMerchantMemoryService({ adapter, repository });

    await expect(
      memoryService.listMerchantMemory("unknown-merchant"),
    ).resolves.toEqual([]);
  });
});
