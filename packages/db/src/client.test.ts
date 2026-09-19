import { describe, expect, it } from "vitest";

describe("getPool", () => {
  it("throws a clear error when DATABASE_URL is not set", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const { getPool } = await import("./client.js");
    expect(() => getPool()).toThrow(/DATABASE_URL is not set/);

    if (original) process.env.DATABASE_URL = original;
  });
});
