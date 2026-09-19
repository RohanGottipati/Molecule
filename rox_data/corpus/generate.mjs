#!/usr/bin/env node
// Generates the messy supplier corpus the ingestion agents have to survive, plus
// the ground truth used to score them. Deterministic: the same --seed produces
// byte-identical files, so a scorecard is comparable across runs.
//
//   node rox_data/corpus/generate.mjs --seed=42 --scale=full
//   node rox_data/corpus/generate.mjs --seed=42 --scale=small --only=emails,wms
//
// Output:
//   rox_data/corpus/inbox/<type>/<file>   the artifacts, as a supplier would send them
//   rox_data/corpus/truth.jsonl           ground truth, never read by the pipeline
//   rox_data/corpus/manifest.json         batch id, seed, counts, chaos coverage
//
// Truth carries two values per fact, because they are different questions:
//   statedValue - what the document literally says (scores extraction fidelity)
//   trueValue   - what is actually true (scores resolution, after conflicting
//                 sources and source-side typos are reconciled)

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MERCHANTS, ALL_CAPS, aliasTable } from "./entities.mjs";
import {
  rng,
  pick,
  chance,
  intBetween,
  mojibake,
  smartQuotes,
  addBom,
  crlf,
  typos,
  truncate,
  ocrNoise,
  renderQuantity,
  renderPrice,
  renderDate,
  renderLeadTime,
  digitTypo,
  INJECTIONS,
  DIMENSIONS,
  CURRENCIES,
} from "./chaos.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const SEED = Number(args.seed ?? 42);
const SCALE = args.scale === "small" ? "small" : "full";
const ONLY = args.only ? String(args.only).split(",") : null;
const OUT = args.out ? String(args.out) : HERE;
const NOW = new Date("2026-09-19T12:00:00Z");

const VOLUMES = {
  full: {
    emails: 120,
    pricesheets: 40,
    threads: 60,
    tickets: 800,
    wms: 30,
    portal: 30,
    briefs: 50,
    invoices: 60,
  },
  small: {
    emails: 12,
    pricesheets: 6,
    threads: 8,
    tickets: 40,
    wms: 4,
    portal: 4,
    briefs: 6,
    invoices: 6,
  },
}[SCALE];

const r = rng(SEED);
const BATCH = `rox-${SCALE}-s${SEED}`;
const truth = [];
const files = [];
const dimensionHits = Object.fromEntries(DIMENSIONS.map((d) => [d, 0]));
const mark = (d) => {
  dimensionHits[d] = (dimensionHits[d] ?? 0) + 1;
};

const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
const id = (...parts) =>
  createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);

/** Queue a file for writing and remember its path for the truth rows. */
function emit(type, name, body, chaos, hint) {
  const path = `${type}/${name}`;
  files.push({ path, body, type, chaos, merchantHint: hint });
  return path;
}

function addTruth(path, merchantId, field, t) {
  truth.push({
    truthId: id(BATCH, path, field, String(truth.length)),
    batchId: BATCH,
    sourcePath: path,
    merchantId,
    field,
    statedValue: t.statedValue ?? null,
    statedUnit: t.statedUnit ?? null,
    trueValue: t.trueValue ?? null,
    trueUnit: t.trueUnit ?? null,
    observedAt: new Date(t.observedAt ?? NOW).toISOString(),
    expect: t.expect ?? "claim",
    isOutlier: Boolean(t.isOutlier),
    shouldQuarantine: t.expect === "quarantine",
    shouldConflict: Boolean(t.shouldConflict),
    isInjection: Boolean(t.isInjection),
    chaos: t.chaos ?? {},
  });
}

// ---------------------------------------------------------------- fact planning

/**
 * Picks how one fact gets stated in one document. Returns the rendered text plus
 * the truth pair. `drift` is a deliberate source-side error: the document is
 * wrong, and only cross-source comparison can catch it.
 */
function stateFact(cap, kind, opts = {}) {
  const chaos = {};
  let text,
    statedValue,
    statedUnit,
    trueValue,
    trueUnit,
    expect = "claim",
    isOutlier = false;

  if (kind === "capacity") {
    trueValue = opts.trueValue ?? cap.capacity;
    trueUnit = `units/${cap.period}`;
    let shown = opts.shownValue ?? trueValue;
    if (opts.drift) {
      shown = Number(digitTypo(r, shown));
      chaos.digit_typo = true;
      mark("digit_typo");
      isOutlier = true;
    }
    const q = renderQuantity(r, shown, cap.period, cap.unit ?? "units");
    text = q.text;
    statedValue = q.restated
      ? q.restated === "week"
        ? shown * 7
        : Math.round(shown / 7)
      : shown;
    statedUnit = q.restated ? `units/${q.restated}` : `units/${cap.period}`;
    if (q.restated) {
      chaos.unit_restated = q.restated;
      mark("unit_restated");
    }
  } else if (kind === "lead_time_hours") {
    trueValue = opts.trueValue ?? cap.leadHours;
    trueUnit = "hours";
    const l = renderLeadTime(r, opts.shownValue ?? trueValue);
    text = l.text;
    // The stated value is whatever number the document prints, in the unit it
    // prints it in - "3 business days" states 3, not 24.
    statedValue = Number(l.text.match(/[\d.]+/)?.[0] ?? trueValue);
    statedUnit = l.restated || "hours";
    if (l.restated) {
      chaos.unit_restated = l.restated;
      mark("unit_restated");
    }
    if (/^under /.test(l.text)) {
      chaos.bound = "upper";
    }
  } else if (kind === "price") {
    trueValue = opts.trueValue ?? cap.price;
    trueUnit = "CAD";
    const currency =
      opts.currency ??
      (chance(r, 0.25) ? pick(r, ["USD", "GBP", "EUR"]) : "CAD");
    text = renderPrice(r, opts.shownValue ?? trueValue, currency);
    statedValue = Number(
      ((opts.shownValue ?? trueValue) * CURRENCIES[currency]).toFixed(2),
    );
    statedUnit = currency;
    if (currency !== "CAD") {
      chaos.currency_mixed = currency;
      mark("currency_mixed");
    }
  } else if (kind === "moq") {
    trueValue = opts.trueValue ?? cap.moq;
    trueUnit = "units";
    text = pick(r, [
      `${trueValue} unit minimum`,
      `MOQ ${trueValue}`,
      `minimum order ${trueValue} pcs`,
    ]);
    statedValue = trueValue;
    statedUnit = "units";
  }

  // A fact nobody can pin down stays unknown - the agent must not invent one.
  if (opts.vague) {
    text = pick(r, [
      "a few hundred",
      "the usual",
      "same as last time",
      "depends on the week",
      "hard to say right now",
    ]);
    statedValue = null;
    trueValue = null;
    expect = "ambiguous";
    chaos.ambiguous = true;
  }

  return {
    text,
    field: `${cap.id}.${kind}`,
    statedValue,
    statedUnit,
    trueValue,
    trueUnit,
    expect,
    isOutlier,
    chaos,
  };
}

/** Applies document-level corruption and records which dimensions were used. */
function corrupt(body, chaos, { allowTruncate = true } = {}) {
  let out = body;
  if (chance(r, 0.18)) {
    out = mojibake(out);
    chaos.encoding = "mojibake";
    mark("encoding");
  } else if (chance(r, 0.15)) {
    out = smartQuotes(out);
    chaos.encoding = "smart_quotes";
    mark("encoding");
  }
  if (chance(r, 0.1)) {
    out = addBom(out);
    chaos.bom = true;
    mark("encoding");
  }
  if (chance(r, 0.12)) {
    out = crlf(out);
    chaos.crlf = true;
  }
  if (chance(r, 0.22)) {
    out = typos(r, out);
    chaos.typos = true;
    mark("typos");
  }
  if (allowTruncate && chance(r, 0.05)) {
    out = truncate(r, out);
    chaos.truncated = true;
    mark("truncated");
  }
  return out;
}

/** Hides an instruction inside supplier text. Always recorded as an injection. */
function maybeInject(body, chaos, path, merchantId) {
  if (!chance(r, 0.06)) return body;
  const payload = pick(r, INJECTIONS);
  chaos.injection = true;
  mark("injection");
  addTruth(path, merchantId, "__injection__", {
    expect: "ignore",
    isInjection: true,
    chaos: { injection: true },
  });
  return chance(r, 0.5) ? `${body}\n\n${payload}\n` : `${payload}\n\n${body}`;
}

const aliasFor = (m) => {
  if (chance(r, 0.55)) {
    mark("alias");
    return pick(r, m.aliases);
  }
  return m.name;
};

// What a supplier actually writes, per kind of fact. Framing a price as a
// capacity sentence would make the document contradict its own truth row.
const EN_SENTENCES = {
  capacity: [
    "Following up on the kit order - our {noun} line is running at {v} right now.",
    "Quick one: we can do {v} on {label} at the moment.",
    "Sorry for the slow reply. {v} is where we're at for {noun} this week.",
    "Confirming {v} for {label}.",
    "Heads up, {noun} is down to {v} until the new machine lands.",
  ],
  lead_time_hours: [
    "Turnaround on {label} is {v} from approval.",
    "We're quoting {v} for {noun} at the moment.",
    "Lead time {v}, assuming artwork is final.",
    "Once the file is approved it's {v} out the door.",
  ],
  price: [
    "Unit price on {label} is {v}.",
    "We're at {v} per piece for {noun}.",
    "Pricing: {v}, setup billed separately.",
    "Best I can do is {v} at this volume.",
  ],
  moq: [
    "Minimum on {label} is {v}.",
    "We'd need {v} to justify a run.",
    "MOQ note: {v}.",
  ],
};
const EN_SUBJECTS = {
  capacity: [
    "Re: capacity for the onboarding kits",
    "Updated {noun} numbers",
    "Quick update",
    "Production update - {label}",
  ],
  lead_time_hours: [
    "Re: turnaround times",
    "Lead time on {label}",
    "RE: RE: schedule",
    "Delivery timing",
  ],
  price: [
    "RE: RE: pricing",
    "Updated price on {label}",
    "Quote - {noun}",
    "Re: costs",
  ],
  moq: ["Minimums", "Re: minimum order quantity", "MOQ for {label}"],
};
const FR_SENTENCE = {
  capacity: (cap, fact) =>
    `Petit suivi sur notre ${cap.noun}. Presentement on est a ${fact.text}.`,
  lead_time_hours: (cap, fact) =>
    `Le delai pour ${cap.label.toLowerCase()} est de ${fact.text}.`,
  price: (cap, fact) =>
    `Le prix unitaire pour ${cap.label.toLowerCase()} est ${fact.text}.`,
  moq: (cap, fact) => `Notre minimum de commande est ${fact.text}.`,
};

// ---------------------------------------------------------------- generators

function genEmail(i) {
  const m = pick(r, MERCHANTS);
  const cap = pick(r, m.capabilities);
  const contact = pick(r, m.contacts);
  const sentAt = daysAgo(intBetween(r, 0, 45));
  const stale = (NOW - sentAt) / 86400000 > 21;
  if (stale) mark("stale");
  const chaos = { type: "email", stale };
  const name = `${String(i).padStart(3, "0")}-${slug(m.id)}-${slug(cap.id)}.eml`;
  const path = `emails/${name}`;

  const kind = pick(r, [
    "capacity",
    "capacity",
    "lead_time_hours",
    "price",
    "moq",
  ]);
  const vague = chance(r, 0.08);
  const drift = chance(r, 0.07);
  const fact = stateFact(cap, kind, { vague, drift });
  Object.assign(chaos, fact.chaos);

  const fr = contact.lang === "fr" && chance(r, 0.5);
  if (fr) mark("multilingual");
  const subject = fr
    ? pick(r, [
        `Mise a jour - ${cap.noun}`,
        `Re: commande - delais`,
        `Capacite de production`,
      ])
    : pick(r, EN_SUBJECTS[kind])
        .replaceAll("{noun}", cap.noun)
        .replaceAll("{label}", cap.label);

  const quoteDate = renderDate(r, daysAgo(intBetween(r, 46, 120)));
  if (quoteDate.ambiguous) {
    chaos.ambiguous_date = true;
    mark("ambiguous_date");
  }

  const lines = fr
    ? [
        `Bonjour,`,
        ``,
        FR_SENTENCE[kind](cap, fact),
        chance(r, 0.4)
          ? `Le delai reste ${renderLeadTime(r, cap.leadHours).text}.`
          : ``,
        ``,
        `Merci,`,
        `${contact.name}`,
        `${contact.role}, ${aliasFor(m)}`,
      ]
    : [
        `Hi,`,
        ``,
        pick(r, EN_SENTENCES[kind])
          .replaceAll("{v}", fact.text)
          .replaceAll("{noun}", cap.noun)
          .replaceAll("{label}", cap.label.toLowerCase()),
        chance(r, 0.35)
          ? `> On ${quoteDate.text} we said ${renderQuantity(r, cap.capacity, cap.period, cap.unit ?? "units").text} - that number is out of date.`
          : ``,
        chance(r, 0.3) ? `Let me know if you need anything else.` : ``,
        ``,
        `Thanks,`,
        `${contact.name}`,
        `${contact.role} | ${aliasFor(m)}`,
        chance(r, 0.25)
          ? `--\nThis email and any attachments are confidential. Capacity figures in signatures are indicative only.`
          : ``,
      ];

  let body = [
    `From: ${contact.name} <${contact.email}>`,
    `To: ops@molecule.example`,
    `Date: ${sentAt.toUTCString()}`,
    `Subject: ${subject}`,
    `Message-ID: <${id(BATCH, path)}@${contact.email.split("@")[1]}>`,
    ``,
    ...lines.filter(Boolean),
  ].join("\n");

  body = maybeInject(body, chaos, path, m.id);
  body = corrupt(body, chaos);
  emit("emails", name, body, chaos, aliasFor(m));
  addTruth(path, m.id, fact.field, { ...fact, observedAt: sentAt, chaos });
  return path;
}

function genPriceSheet(i) {
  const m = pick(r, MERCHANTS);
  const chaos = { type: "pricesheet" };
  const name = `${String(i).padStart(3, "0")}-${slug(m.id)}-prices.csv`;
  const path = `pricesheets/${name}`;
  const currency = chance(r, 0.3) ? pick(r, ["USD", "GBP"]) : "CAD";
  if (currency !== "CAD") {
    chaos.currency_mixed = currency;
    mark("currency_mixed");
  }

  const rows = [];
  // Junk above the header is the single most common spreadsheet sin.
  if (chance(r, 0.6)) {
    const eff = renderDate(r, daysAgo(intBetween(r, 1, 90)));
    if (eff.ambiguous) {
      chaos.ambiguous_date = true;
      mark("ambiguous_date");
    }
    rows.push([`${aliasFor(m)} - PRICE LIST`], [`Effective ${eff.text}`], []);
  }
  rows.push([
    "SKU",
    "Item",
    "Tier",
    `Unit price (${currency})`,
    "MOQ",
    "Lead time",
  ]);

  for (const cap of m.capabilities) {
    const sku = chance(r, 0.4)
      ? `${cap.id.slice(4, 9).toUpperCase()} ${intBetween(r, 100, 999)}`
      : `${cap.id.slice(4, 9).toUpperCase()}-${intBetween(r, 100, 999)}`;
    if (sku.includes(" ")) {
      chaos.sku_drift = true;
      mark("sku_drift");
    }
    const price = stateFact(cap, "price", { currency });
    const lead = stateFact(cap, "lead_time_hours");
    const moq = stateFact(cap, "moq");
    const noPrice = chance(r, 0.12);
    rows.push([
      sku,
      cap.label,
      "1-49",
      noPrice ? "call for pricing" : price.text.replace(/,/g, ""),
      moq.statedValue,
      lead.text,
    ]);
    if (chance(r, 0.7))
      rows.push([
        "",
        "",
        "50-249",
        noPrice ? "" : (Number(price.statedValue) * 0.9).toFixed(2),
        "",
        "",
      ]);
    if (chance(r, 0.5))
      rows.push([
        "",
        "",
        "250+",
        noPrice ? "" : (Number(price.statedValue) * 0.8).toFixed(2),
        "",
        "",
      ]);

    if (noPrice) {
      chaos.missing = true;
      mark("missing");
      addTruth(path, m.id, price.field, {
        ...price,
        statedValue: null,
        expect: "ambiguous",
        chaos,
      });
    } else {
      addTruth(path, m.id, price.field, { ...price, chaos });
    }
    addTruth(path, m.id, moq.field, { ...moq, chaos });
    addTruth(path, m.id, lead.field, { ...lead, chaos });
  }
  if (chance(r, 0.35))
    rows.push(
      [],
      [
        "Note: prices exclude setup fees and are subject to change without notice.",
      ],
    );

  let body = rows
    .map((row) =>
      row
        .map((c) =>
          String(c ?? "").includes(",") ? `"${c}"` : String(c ?? ""),
        )
        .join(","),
    )
    .join("\n");
  body = corrupt(body, chaos, { allowTruncate: false });
  emit("pricesheets", name, body, chaos, aliasFor(m));
  return path;
}

function genThread(i) {
  const m = pick(r, MERCHANTS);
  const cap = pick(r, m.capabilities);
  const contact = pick(r, m.contacts);
  const chaos = { type: "thread" };
  const name = `${String(i).padStart(3, "0")}-${slug(m.id)}-wa.txt`;
  const path = `threads/${name}`;
  const day = daysAgo(intBetween(r, 0, 30));
  const stamp = (mins) =>
    `[${day.toISOString().slice(0, 10)}, ${String(9 + Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}]`;

  // The correction pattern: a number is stated, then revised in the same thread.
  const first = stateFact(cap, "capacity");
  const revisedValue = Math.max(
    0,
    Math.round(cap.capacity * pick(r, [0.5, 0.25, 0.75, 0])),
  );
  const revised = stateFact(cap, "capacity", {
    trueValue: revisedValue,
    shownValue: revisedValue,
  });
  Object.assign(chaos, revised.chaos, { correction: true });

  const msgs = [
    `${stamp(0)} Molecule Ops: hey ${contact.name.split(" ")[0]} whats your ${cap.noun} looking like this week`,
    `${stamp(intBetween(r, 3, 40))} ${contact.name}: ${pick(r, ["hey", "hi", "yo"])} ${first.text} ${pick(r, ["", "roughly", "give or take", "ish"])}`.trim(),
    `${stamp(intBetween(r, 45, 120))} ${contact.name}: ${pick(r, ["actually hold on", "sorry scratch that", "correction"])} ${revised.text} ${pick(r, ["machine is down", "one head is down", "we lost a shift", "staff out sick"])}`,
    chance(r, 0.4)
      ? `${stamp(intBetween(r, 121, 200))} Molecule Ops: ok noted`
      : "",
    chance(r, 0.3)
      ? `${stamp(intBetween(r, 201, 300))} ${contact.name}: <voice note, 0:42>`
      : "",
  ].filter(Boolean);

  let body = msgs.join("\n");
  body = maybeInject(body, chaos, path, m.id);
  body = corrupt(body, chaos);
  emit("threads", name, body, chaos, aliasFor(m));
  // Only the correction is true. The superseded first number must lose.
  addTruth(path, m.id, revised.field, { ...revised, observedAt: day, chaos });
  return path;
}

const TICKET_SCHEMAS = ["v1", "v2", "v3"];
function genTickets(i) {
  // One export file per batch of tickets, in one of three schema generations.
  const schema = pick(r, TICKET_SCHEMAS);
  const chaos = { type: "tickets", schema_version: schema };
  mark("schema_drift");
  const name = `${String(i).padStart(3, "0")}-tickets-${schema}.json`;
  const path = `tickets/${name}`;
  const count = intBetween(r, 5, 25);
  const rows = [];
  for (let n = 0; n < count; n++) {
    const m = pick(r, MERCHANTS);
    const cap = pick(r, m.capabilities);
    const opened = daysAgo(intBetween(r, 0, 60));
    const reason = pick(r, [
      "arrived damaged - box crushed",
      "wrong size hoodie, ordered L got M",
      "embroidery thread colour is off",
      "engraving misspelled the name",
      "never arrived, tracking stuck",
      "missing 3 units from the case",
      "snack pack had nuts, customer is allergic",
      "late by two days",
    ]);
    const base = {
      merchant: aliasFor(m),
      capability: cap.label,
      opened_at: opened.toISOString(),
      reason,
    };
    if (schema === "v1")
      rows.push({
        id: `T-${id(path, String(n))}`,
        ...base,
        status: pick(r, ["open", "closed", "OPEN", "Closed "]),
      });
    else if (schema === "v2")
      rows.push({
        ticket_id: `T-${id(path, String(n))}`,
        merchant_name: base.merchant,
        capability_name: base.capability,
        created: base.opened_at,
        body: { text: reason },
        state: pick(r, ["open", "resolved"]),
      });
    else
      rows.push({
        ticketId: `T-${id(path, String(n))}`,
        party: { name: base.merchant },
        subject: cap.label,
        createdAt: base.opened_at,
        description: reason,
        meta: {
          state: pick(r, ["open", "resolved"]),
          channel: pick(r, ["email", "chat", "phone"]),
        },
      });
  }
  const payload =
    schema === "v3" ? { export: { version: 3, tickets: rows } } : rows;
  let body = JSON.stringify(payload, null, 2);
  if (chance(r, 0.08)) {
    body = truncate(r, body);
    chaos.truncated = true;
    mark("truncated");
  }
  emit("tickets", name, body, chaos, null);
  // Tickets carry no capability facts, only defect signal; no truth rows.
  return path;
}

function genWms(i) {
  // The warehouse system disagrees with Shopify on purpose: this is the
  // three-way reconciliation the resolver has to survive.
  const day = daysAgo(i);
  const chaos = { type: "wms", contradiction: true };
  mark("contradiction");
  const name = `wms-${day.toISOString().slice(0, 10)}.csv`;
  const path = `wms/${name}`;
  const rows = [
    ["snapshot_date", "location", "item_code", "description", "on_hand", "uom"],
  ];
  for (const cap of ALL_CAPS) {
    if (!chance(r, 0.7)) continue;
    const drift = chance(r, 0.45);
    const shown = drift
      ? Math.round(cap.capacity * pick(r, [0.5, 0.75, 1.25]))
      : cap.capacity;
    const itemCode = chance(r, 0.5)
      ? cap.id.toUpperCase().replaceAll("-", "_")
      : cap.id;
    if (itemCode !== cap.id) {
      chaos.sku_drift = true;
      mark("sku_drift");
    }
    rows.push([
      chance(r, 0.3)
        ? `${day.getUTCDate()}/${day.getUTCMonth() + 1}`
        : day.toISOString().slice(0, 10),
      pick(r, ["MTL-01", "TOR-02", "mtl-01", "Montreal DC"]),
      itemCode,
      cap.label,
      shown,
      pick(r, ["EA", "ea", "units", "UNIT"]),
    ]);
    addTruth(path, cap.merchant.id, `${cap.id}.capacity`, {
      statedValue: shown,
      statedUnit: `units/${cap.period}`,
      trueValue: cap.capacity,
      trueUnit: `units/${cap.period}`,
      observedAt: day,
      isOutlier: drift,
      shouldConflict: drift,
      chaos,
    });
  }
  let body = rows.map((row) => row.join(",")).join("\n");
  body = corrupt(body, chaos, { allowTruncate: false });
  emit("wms", name, body, chaos, "WMS export");
  return path;
}

function genPortal(i) {
  const m = pick(r, MERCHANTS);
  const chaos = { type: "portal" };
  const observed = daysAgo(intBetween(r, 5, 90));
  const stale = (NOW - observed) / 86400000 > 21;
  if (stale) {
    chaos.stale = true;
    mark("stale");
  }
  const name = `${String(i).padStart(3, "0")}-${slug(m.id)}-portal.json`;
  const path = `portal/${name}`;
  const payload = {
    supplier: aliasFor(m),
    pulled_at: observed.toISOString(),
    capabilities: [],
  };
  for (const cap of m.capabilities) {
    const missing = chance(r, 0.25);
    if (missing) {
      chaos.missing = true;
      mark("missing");
    }
    const f = stateFact(cap, "capacity");
    payload.capabilities.push({
      code: cap.id,
      name: cap.label,
      daily_capacity: missing
        ? pick(r, ["N/A", "", null, "unknown"])
        : f.statedValue,
      unit: missing ? null : f.statedUnit,
      lead_time: chance(r, 0.2) ? null : `${cap.leadHours}h`,
      last_confirmed: observed.toISOString(),
    });
    addTruth(path, m.id, f.field, {
      ...f,
      statedValue: missing ? null : f.statedValue,
      expect: missing ? "ambiguous" : "claim",
      observedAt: observed,
      chaos,
    });
  }
  const body = JSON.stringify(payload, null, 2);
  emit("portal", name, body, chaos, aliasFor(m));
  return path;
}

function genBrief(i) {
  const chaos = { type: "brief" };
  const name = `${String(i).padStart(3, "0")}-intake.txt`;
  const path = `briefs/${name}`;
  const qty = intBetween(r, 50, 400);
  const budget = intBetween(r, 4, 12) * 1000;
  const due = renderDate(r, daysAgo(-intBetween(r, 7, 30)));
  if (due.ambiguous) {
    chaos.ambiguous_date = true;
    mark("ambiguous_date");
  }
  const lines = [
    pick(r, [
      `We need ${qty} premium black onboarding kits by ${due.text}, under CAD ${budget}.`,
      `Looking for ~${qty} onboarding kits, black, budget around $${budget}.`,
      `Hi - quote for ${qty} welcome kits? Need them ${pick(r, ["next month", "by end of quarter", "ASAP"])}.`,
    ]),
    pick(r, [
      "No leather.",
      "no leather please",
      "Nothing with leather in it.",
    ]),
    chance(r, 0.6)
      ? pick(r, [
          "Hoodie needs our logo embroidered.",
          "logo on the hoodie (embroidery not print)",
        ])
      : "",
    chance(r, 0.5) ? "Bottles should be engraved with each person's name." : "",
    chance(r, 0.5)
      ? pick(r, ["Snacks must be vegan.", "vegan snacks only"])
      : "",
    chance(r, 0.4) ? "Each kit packaged individually." : "",
    // The late correction that the canonical demo depends on.
    chance(r, 0.35)
      ? pick(r, [
          "Actually - no polyester either.",
          "One more thing: no polyester.",
          "Forgot to say: nothing polyester.",
        ])
      : "",
  ].filter(Boolean);
  let body = lines.join("\n");
  body = corrupt(body, chaos);
  emit("briefs", name, body, chaos, null);
  return path;
}

function genInvoice(i) {
  // A scanned supplier invoice, OCR'd. Two independent problems: the OCR mangles
  // digits into letters (unparseable -> must quarantine, never guess), and the
  // invoice sometimes bills a different unit price than the agreed one (a real
  // discrepancy -> must surface, not silently accept).
  const m = pick(r, MERCHANTS);
  const chaos = { type: "invoice", ocr: true };
  mark("ocr");
  const issued = daysAgo(intBetween(r, 2, 70));
  const name = `${String(i).padStart(3, "0")}-${slug(m.id)}-inv.txt`;
  const path = `invoices/${name}`;
  const po = `PO-${intBetween(r, 10000, 99999)}`;
  const lines = [
    `${aliasFor(m).toUpperCase()}`,
    `INVOICE  ${id(BATCH, path).toUpperCase().slice(0, 8)}`,
    `Date: ${renderDate(r, issued).text}    Ref: ${po}`,
    ``,
    `Description                     Qty     Unit      Amount`,
    `------------------------------------------------------------`,
  ];
  let total = 0;
  for (const cap of m.capabilities) {
    const qty = intBetween(r, 20, 400);
    const overbilled = chance(r, 0.3);
    const billed = overbilled
      ? Number((cap.price * pick(r, [1.1, 1.25, 1.5])).toFixed(2))
      : cap.price;
    const garbled = chance(r, 0.25);
    const shown = garbled
      ? billed
          .toFixed(2)
          .replace(/1/g, "l")
          .replace(/0/g, "O")
          .replace(/5/g, "S")
      : billed.toFixed(2);
    if (garbled) chaos.ocr_unparseable = true;
    if (overbilled) {
      chaos.contradiction = true;
      mark("contradiction");
    }
    total += qty * billed;
    lines.push(
      `${cap.label.padEnd(30).slice(0, 30)}  ${String(qty).padStart(5)}  ${shown.padStart(8)}  ${(qty * billed).toFixed(2).padStart(9)}`,
    );
    addTruth(path, m.id, `${cap.id}.price`, {
      statedValue: garbled ? null : billed,
      statedUnit: "CAD",
      trueValue: cap.price,
      trueUnit: "CAD",
      observedAt: issued,
      expect: garbled ? "quarantine" : "claim",
      isOutlier: overbilled,
      shouldConflict: overbilled,
      chaos,
    });
  }
  // Totals that do not add up: the other half of invoice reconciliation.
  const statedTotal = chance(r, 0.25) ? total * 1.07 : total;
  if (statedTotal !== total) chaos.total_mismatch = true;
  lines.push(
    `------------------------------------------------------------`,
    `TOTAL (CAD)${statedTotal.toFixed(2).padStart(49)}`,
  );

  let body = lines.join("\n");
  body = ocrNoise(r, body, 0.012);
  emit("invoices", name, body, chaos, aliasFor(m));
  return path;
}

// ---------------------------------------------------------------- run

const GENERATORS = {
  emails: genEmail,
  pricesheets: genPriceSheet,
  threads: genThread,
  tickets: genTickets,
  wms: genWms,
  portal: genPortal,
  briefs: genBrief,
  invoices: genInvoice,
};

await rm(join(OUT, "inbox"), { recursive: true, force: true });
for (const [type, count] of Object.entries(VOLUMES)) {
  if (ONLY && !ONLY.includes(type)) continue;
  for (let i = 0; i < count; i++) GENERATORS[type](i);
}

// Duplicates: the same bytes forwarded from a second address. Corroboration, not noise.
const dupeCount = Math.max(1, Math.round(files.length * 0.03));
for (const f of files.slice(0, dupeCount)) {
  const name = f.path
    .split("/")
    .pop()
    .replace(/(\.\w+)$/, "-fwd$1");
  emit(
    f.type,
    name,
    `From: forwarded@molecule.example\nX-Forwarded: true\n\n${f.body}`,
    { ...f.chaos, duplicate: true },
    f.merchantHint,
  );
  mark("duplicate");
  for (const t of truth.filter((t) => t.sourcePath === f.path)) {
    addTruth(`${f.type}/${name}`, t.merchantId, t.field, {
      ...t,
      statedValue: t.statedValue,
      chaos: { ...t.chaos, duplicate: true },
    });
  }
}

for (const f of files) {
  const full = join(OUT, "inbox", f.path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, f.body, "utf8");
}
await writeFile(
  join(OUT, "truth.jsonl"),
  truth.map((t) => JSON.stringify(t)).join("\n") + "\n",
  "utf8",
);
await writeFile(
  join(OUT, "manifest.json"),
  JSON.stringify(
    {
      batchId: BATCH,
      seed: SEED,
      scale: SCALE,
      generatedAt: NOW.toISOString(),
      artifacts: files.length,
      byType: Object.fromEntries(
        Object.keys(VOLUMES).map((t) => [
          t,
          files.filter((f) => f.type === t).length,
        ]),
      ),
      truthRows: truth.length,
      expectations: truth.reduce(
        (acc, t) => ({ ...acc, [t.expect]: (acc[t.expect] ?? 0) + 1 }),
        {},
      ),
      chaosCoverage: dimensionHits,
      aliases: aliasTable().length,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(
  `batch ${BATCH}: ${files.length} artifacts, ${truth.length} truth rows -> ${join(OUT, "inbox")}`,
);
console.table(
  Object.entries(dimensionHits).map(([dimension, hits]) => ({
    dimension,
    hits,
  })),
);
