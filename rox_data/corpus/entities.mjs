// The real universe the corpus talks about: the merchants, capabilities and
// baseline values that already exist in Tiger (see `select * from capabilities`).
// Aliases are the names the same supplier is known by across emails, spreadsheets
// and legacy systems - entity resolution has to collapse them back to `id`.

export const MERCHANTS = [
  {
    id: "thread-forge",
    name: "Thread Forge",
    store: "threadforge-eznglsyk",
    // `m-customizeco` is the same real supplier under the pre-integration seed.
    aliases: ["ThreadForge", "Thread Forge Inc.", "Thread Forge Embroidery", "TF Embroidery", "T-Forge", "threadforge", "CustomizeCo"],
    legacyId: "m-customizeco",
    contacts: [
      { name: "Marie-Claude Bouchard", email: "mc.bouchard@threadforge.ca", role: "Production Lead", lang: "fr" },
      { name: "Dev Patel", email: "dev@threadforge.ca", role: "Account Manager", lang: "en" },
    ],
    capabilities: [
      { id: "cap-thread-embroidery", label: "Logo embroidery", noun: "embroidery", unit: "pieces", capacity: 400, period: "day", leadHours: 16, price: 1.13, moq: 12 },
    ],
  },
  {
    id: "stitch-works",
    name: "StitchWorks",
    store: "stitchworks-7gw6fagb",
    aliases: ["Stitch Works", "StitchWorks Ltd", "Stitch-Works Embroidery", "SW Embroidery", "stitchworks"],
    legacyId: null,
    contacts: [{ name: "Dana Okonkwo", email: "dana@stitchworks.example", role: "Owner", lang: "en" }],
    capabilities: [
      { id: "cap-stitch-embroidery", label: "Logo embroidery", noun: "embroidery", unit: "pieces", capacity: 20, period: "day", leadHours: 24, price: 1.0, moq: 12 },
    ],
  },
  {
    id: "needle-north",
    name: "Needle North",
    store: null, // DB-only supplier: no Shopify store, so Shopify can never corroborate it
    aliases: ["NeedleNorth", "Needle North Stitching", "Needle N.", "NN Embroidery"],
    legacyId: "m-customizeco2",
    contacts: [{ name: "Priya Raman", email: "priya@needlenorth.ca", role: "Scheduler", lang: "en" }],
    capabilities: [
      { id: "cap-needle-embroidery", label: "Logo embroidery backup", noun: "embroidery", unit: "pieces", capacity: 300, period: "day", leadHours: 20, price: 1.35, moq: 24 },
    ],
  },
  {
    id: "laser-lab",
    name: "Laser Lab",
    store: "laserlab-yprjwhc5",
    aliases: ["LaserLab", "Laser Lab Engraving", "LaserLab Co", "L-Lab", "laserlab"],
    legacyId: null,
    contacts: [{ name: "Tomas Vieira", email: "tomas@laserlab.example", role: "Shop Manager", lang: "en" }],
    capabilities: [
      { id: "cap-laser-engraving", label: "Individual name engraving", noun: "engraving", unit: "bottles", capacity: 400, period: "day", leadHours: 12, price: 2.4, moq: 12 },
    ],
  },
  {
    id: "pack-ship",
    name: "Pack & Ship",
    store: "packship-5lfaj5qq",
    aliases: ["PackShip", "Pack and Ship", "Pack & Ship Logistics", "P&S", "packship"],
    legacyId: "m-packship",
    contacts: [{ name: "Aline Tremblay", email: "aline@packship.ca", role: "Ops", lang: "fr" }],
    capabilities: [
      { id: "cap-pack-assembly", label: "Individual kit packaging", noun: "assembly", unit: "kits", capacity: 600, period: "day", leadHours: 6, price: 1.85, moq: 25 },
      { id: "cap-pack-fulfillment", label: "Canadian kit fulfillment", noun: "fulfilment", unit: "kits", capacity: 600, period: "day", leadHours: 12, price: 2.1, moq: 25 },
    ],
  },
  {
    id: "base-goods",
    name: "Base Goods",
    store: "basegoods-tyefhh8o",
    aliases: ["BaseGoods", "Base Goods Supply", "BaseGoods Wholesale", "BG Supply", "basegoods"],
    legacyId: "m-basegoods",
    contacts: [{ name: "Ruth Alvarez", email: "ruth@basegoods.example", role: "Wholesale", lang: "en" }],
    capabilities: [
      { id: "cap-base-hoodie", label: "Premium black cotton hoodie", noun: "hoodies", unit: "hoodies", capacity: 1000, period: "week", leadHours: 8, price: 38.0, moq: 24 },
      { id: "cap-base-bottle", label: "Black stainless steel bottle", noun: "bottles", unit: "bottles", capacity: 1000, period: "week", leadHours: 8, price: 22.5, moq: 24 },
    ],
  },
  {
    id: "snack-box",
    name: "Snack Box",
    store: "snackbox-0hubj57j",
    aliases: ["SnackBox", "Snack Box Co", "SnackBox Foods", "snackbox"],
    legacyId: null,
    contacts: [{ name: "Yusuf Demir", email: "yusuf@snackbox.example", role: "Sales", lang: "en" }],
    capabilities: [
      { id: "cap-snacks", label: "Vegan snack selection", noun: "snack packs", unit: "snack packs", capacity: 1000, period: "week", leadHours: 6, price: 6.75, moq: 50 },
    ],
  },
];

export const BY_ID = Object.fromEntries(MERCHANTS.map((m) => [m.id, m]));
export const ALL_CAPS = MERCHANTS.flatMap((m) => m.capabilities.map((c) => ({ ...c, merchant: m })));

/** Every alias in the universe, with the id it should resolve to. */
export function aliasTable() {
  const rows = [];
  for (const m of MERCHANTS) {
    rows.push({ alias: m.name, kind: "merchant", resolved: m.id });
    for (const a of m.aliases) rows.push({ alias: a, kind: "merchant", resolved: m.id });
    if (m.store) rows.push({ alias: m.store, kind: "merchant", resolved: m.id });
    if (m.legacyId) rows.push({ alias: m.legacyId, kind: "merchant", resolved: m.id });
  }
  return rows;
}
