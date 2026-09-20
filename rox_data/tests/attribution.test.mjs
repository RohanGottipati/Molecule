import assert from "node:assert/strict";
import test from "node:test";
import { decideCapability, terms } from "../pipeline/attribution.mjs";

const caps = [
  {
    capability_id: "cap-stitch-embroidery",
    merchant_id: "stitch-works",
    name: "Logo embroidery",
    description: "Custom logo embroidery on apparel",
  },
  {
    capability_id: "cap-laser-engraving",
    merchant_id: "laser-lab",
    name: "Individual name engraving",
    description: "Laser engraving on bottles",
  },
  {
    capability_id: "cap-pack-assembly",
    merchant_id: "pack-ship",
    name: "Individual kit packaging",
    description: "Kit assembly",
  },
  {
    capability_id: "cap-pack-fulfillment",
    merchant_id: "pack-ship",
    name: "Canadian kit fulfillment",
    description: "Fulfilment and shipping",
  },
];
const own = (id) => caps.filter((c) => c.merchant_id === id);

test("a supplier with one capability still takes a fact about that capability", () => {
  const r = decideCapability({
    own: own("stitch-works"),
    all: caps,
    hint: "logo embroidery",
  });
  assert.equal(r.capabilityId, "cap-stitch-embroidery");
  assert.equal(r.method, "only");
  assert.equal(r.score, 0.8);
});

test("an inferred-only attribution with no hint is recorded as weaker", () => {
  const r = decideCapability({ own: own("stitch-works"), all: caps, hint: "" });
  assert.equal(r.capabilityId, "cap-stitch-embroidery");
  assert.equal(r.score, 0.6);
});

test("a subject naming another capability is not attached to the only one", () => {
  const r = decideCapability({
    own: own("stitch-works"),
    all: caps,
    hint: "bottle engraving",
  });
  assert.equal(r.capabilityId, null);
  assert.equal(r.reason, "contradicts_hint");
  assert.deepEqual(r.terms, ["engraving"]);
});

test("a generic subject is not treated as a contradiction", () => {
  for (const hint of [
    "hoodies",
    "units",
    "black cotton hoodies",
    "Item 4711",
  ]) {
    const r = decideCapability({ own: own("stitch-works"), all: caps, hint });
    assert.equal(r.capabilityId, "cap-stitch-embroidery", hint);
  }
});

test("our own capability identifier is an exact match", () => {
  const r = decideCapability({
    own: own("pack-ship"),
    all: caps,
    hint: "cap-pack-assembly",
  });
  assert.deepEqual(r, {
    capabilityId: "cap-pack-assembly",
    method: "exact",
    score: 1,
  });
});

test("several capabilities need a hint, a similarity floor and a margin", () => {
  const p = own("pack-ship");
  assert.equal(
    decideCapability({ own: p, all: caps, hint: "" }).reason,
    "no_hint",
  );
  assert.equal(
    decideCapability({
      own: p,
      all: caps,
      hint: "kits",
      ranked: [{ capability_id: "cap-pack-assembly", sim: 0.1 }],
    }).reason,
    "below_threshold",
  );
  const close = decideCapability({
    own: p,
    all: caps,
    hint: "kits",
    ranked: [
      { capability_id: "cap-pack-assembly", sim: 0.41 },
      { capability_id: "cap-pack-fulfillment", sim: 0.39 },
    ],
  });
  assert.equal(close.reason, "ambiguous_margin");
  assert.equal(close.capabilityId, null);
  const clear = decideCapability({
    own: p,
    all: caps,
    // No word in common with either capability, so only similarity can decide.
    hint: "wrap and box service",
    ranked: [
      { capability_id: "cap-pack-assembly", sim: 0.62 },
      { capability_id: "cap-pack-fulfillment", sim: 0.2 },
    ],
  });
  assert.equal(clear.capabilityId, "cap-pack-assembly");
  assert.equal(clear.method, "trgm");
});

test("a supplier with no capabilities cannot be attributed", () => {
  assert.equal(
    decideCapability({ own: [], all: caps, hint: "embroidery" }).reason,
    "no_capabilities",
  );
});

test("terms drops generic words and short tokens", () => {
  assert.deepEqual(terms("Logo embroidery on black cotton hoodies"), [
    "embroidery",
  ]);
});

test("word overlap singles out one capability when trigram similarity is too low", () => {
  const stores = [
    {
      capability_id: "cap-base-hoodie",
      merchant_id: "base-goods",
      name: "Premium black cotton hoodie",
      description: "Blank hoodies",
    },
    {
      capability_id: "cap-base-bottle",
      merchant_id: "base-goods",
      name: "Black stainless steel bottle",
      description: "Blank bottles",
    },
  ];
  for (const [hint, want] of [
    ["our hoodies line", "cap-base-hoodie"],
    ["hoodies", "cap-base-hoodie"],
    ["bottles", "cap-base-bottle"],
    ["stainless steel", "cap-base-bottle"],
  ]) {
    const r = decideCapability({
      own: stores,
      all: [...stores, ...caps],
      hint,
      ranked: [],
    });
    assert.equal(r.capabilityId, want, hint);
    assert.equal(r.method, "terms");
  }
  const pack = decideCapability({
    own: own("pack-ship"),
    all: caps,
    hint: "our assembly",
    ranked: [],
  });
  assert.equal(pack.capabilityId, "cap-pack-assembly");
  const fulfil = decideCapability({
    own: own("pack-ship"),
    all: caps,
    hint: "our fulfilment",
    ranked: [],
  });
  assert.equal(fulfil.capabilityId, "cap-pack-fulfillment");
});

test("word overlap that fits several capabilities equally falls back to similarity, then abstains", () => {
  const stores = [
    {
      capability_id: "cap-a",
      merchant_id: "m",
      name: "Kit packaging",
      description: "",
    },
    {
      capability_id: "cap-b",
      merchant_id: "m",
      name: "Kit fulfillment",
      description: "",
    },
  ];
  const r = decideCapability({
    own: stores,
    all: stores,
    hint: "kit packaging fulfillment",
    ranked: [],
  });
  assert.equal(r.capabilityId, null);
  assert.equal(r.reason, "below_threshold");
});
