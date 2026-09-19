// Generates a realistic, varied merchant/product catalog: ~100+ competing
// merchants offering materials, transforms, and fulfillment across ~85
// distinct end products spanning apparel, leather, home/kitchen, furniture,
// appliances/electronics, outdoor/lighting, food/packaging, beauty, pet,
// office, sports/wellness, and baby goods -- so the solver has real prices
// to compare across genuinely different markets instead of one flow
// repeated forever. Additive: does NOT touch the original 4 demo merchants
// (m-basegoods etc.) from 004_seed.sql -- those stay for the Rox
// conflict-resolution acceptance demo.
//
// Run:
//   pnpm --filter @molecule/db generate-catalog
//
// Writes a reference file to packages/db/catalog-reference.json listing
// every product and which merchants can supply each step, for picking demo
// prompts.
import pg from "pg";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Client } = pg;

type Material = { key: string; name: string; category: string };
type Transform = { key: string; name: string; accepts: string[] };

const MATERIALS: Material[] = [
  { key: "cotton_tshirt", name: "Cotton t-shirt blank", category: "apparel" },
  { key: "cotton_hoodie", name: "Cotton hoodie blank", category: "apparel" },
  { key: "denim_jacket", name: "Denim jacket blank", category: "apparel" },
  { key: "canvas_tote_bag", name: "Canvas tote bag blank", category: "apparel" },
  { key: "leather_wallet_blank", name: "Leather wallet blank", category: "leather" },
  { key: "leather_belt_blank", name: "Leather belt blank", category: "leather" },
  { key: "ceramic_mug_blank", name: "Ceramic mug blank", category: "ceramic" },
  { key: "glass_ornament_blank", name: "Glass ornament blank", category: "glass" },
  { key: "acrylic_keychain_blank", name: "Acrylic keychain blank", category: "acrylic" },
  { key: "wood_cutting_board_blank", name: "Wood cutting board blank", category: "wood" },
  { key: "metal_water_bottle_blank", name: "Metal water bottle blank", category: "metal" },
  { key: "silicone_phone_case_blank", name: "Silicone phone case blank", category: "silicone" },
  { key: "vinyl_sticker_sheet_blank", name: "Vinyl sticker sheet blank", category: "vinyl" },
  { key: "candle_wax_blank", name: "Candle wax blank", category: "wax" },
  { key: "paper_poster_blank", name: "Paper poster blank", category: "paper" },
  // Furniture
  { key: "wood_table_top_blank", name: "Wood table top blank", category: "furniture" },
  { key: "metal_chair_frame_blank", name: "Metal chair frame blank", category: "furniture" },
  { key: "upholstery_fabric_roll", name: "Upholstery fabric roll", category: "furniture" },
  { key: "steel_shelf_bracket_blank", name: "Steel shelf bracket blank", category: "furniture" },
  // Appliances / electronics
  { key: "mini_fridge_shell_blank", name: "Mini fridge shell blank", category: "appliance" },
  { key: "speaker_casing_blank", name: "Speaker casing blank", category: "electronics" },
  // Outdoor / lighting
  { key: "bike_frame_blank", name: "Bike frame blank", category: "outdoor" },
  { key: "garden_planter_blank", name: "Garden planter blank", category: "outdoor" },
  { key: "glass_lamp_shade_blank", name: "Glass lamp shade blank", category: "lighting" },
  // Corporate onboarding-kit categories (researched against real Shopify
  // merchants -- see REAL_MERCHANTS below): vegan snacks and custom
  // packaging don't need a transform step, they go straight to fulfillment.
  { key: "vegan_snack_pack", name: "Vegan snack pack", category: "food" },
  { key: "custom_packaging_blank", name: "Custom branded packaging box", category: "packaging" },
  // Additional markets: beauty, pet, office, sports/wellness, baby.
  { key: "soap_bar_blank", name: "Soap bar blank", category: "beauty" },
  { key: "pet_bandana_blank", name: "Pet bandana blank", category: "pet" },
  { key: "notebook_cover_blank", name: "Notebook cover blank", category: "office" },
  { key: "yoga_mat_blank", name: "Yoga mat blank", category: "sports" },
  { key: "baby_onesie_blank", name: "Baby onesie blank", category: "baby" },
];

// Real Shopify (or Shopify-adjacent) merchants found via research, seeded in
// as the first provider(s) for the categories in the onboarding-kit demo
// (embroidered hoodies, engraved bottles, vegan snacks, custom packaging) so
// the demo isn't just procedurally-named stores -- pricing below is
// anchored to what these merchants actually publish. Everything else is
// filled out with generated competitor names to reach real store counts.
const REAL_MERCHANTS: Record<string, { name: string; note: string }[]> = {
  cotton_hoodie: [
    { name: "Apliiq", note: "real Shopify print-on-demand apparel + embroidery partner, apliiq.com" },
  ],
  embroidery: [
    { name: "Apliiq", note: "apliiq.com/custom/embroidery -- no-minimum custom embroidery" },
    { name: "Printful", note: "printful.com -- Shopify POD embroidery partner" },
  ],
  metal_water_bottle_blank: [
    { name: "Merchology", note: "merchology.com/collections/drinkware -- real tumbler priced at $4.99" },
    { name: "Corporate Gear", note: "corporategear.com/accessories/drinkware/bottles.html" },
  ],
  engraving: [
    { name: "Crystal Imagery", note: "crystalimagery.com -- real 32oz laser-engraved insulated bottle, wholesale logo bottles" },
  ],
  vegan_snack_pack: [
    { name: "Packed with Purpose", note: "shop.packedwithpurpose.gifts -- real vegan pretzel braids $5/5oz, gift boxes $149.99-$229.99" },
    { name: "Emmy's Organics", note: "Shopify success story, organic/vegan snack brand" },
  ],
  custom_packaging_blank: [
    { name: "Brandable Box", note: "brandablebox.io -- Shopify app + merchant for logo-branded shipping boxes" },
    { name: "G10 Fulfillment", note: "g10fulfillment.com -- custom packaging + 3PL" },
  ],
};

const TRANSFORMS: Transform[] = [
  { key: "embroidery", name: "Embroidery", accepts: ["cotton_tshirt", "cotton_hoodie", "denim_jacket", "canvas_tote_bag", "pet_bandana_blank", "baby_onesie_blank"] },
  { key: "screen_printing", name: "Screen printing", accepts: ["cotton_tshirt", "cotton_hoodie", "canvas_tote_bag", "paper_poster_blank", "yoga_mat_blank"] },
  { key: "engraving", name: "Engraving", accepts: ["leather_wallet_blank", "leather_belt_blank", "wood_cutting_board_blank", "metal_water_bottle_blank", "acrylic_keychain_blank"] },
  { key: "laser_cutting", name: "Laser cutting", accepts: ["acrylic_keychain_blank", "wood_cutting_board_blank"] },
  { key: "dyeing", name: "Dyeing", accepts: ["denim_jacket", "canvas_tote_bag", "cotton_tshirt"] },
  { key: "uv_printing", name: "UV printing", accepts: ["ceramic_mug_blank", "metal_water_bottle_blank", "silicone_phone_case_blank", "glass_ornament_blank"] },
  { key: "vinyl_cutting", name: "Vinyl cutting", accepts: ["vinyl_sticker_sheet_blank"] },
  { key: "hand_painting", name: "Hand painting", accepts: ["ceramic_mug_blank", "glass_ornament_blank", "candle_wax_blank", "glass_lamp_shade_blank"] },
  { key: "heat_pressing", name: "Heat pressing", accepts: ["cotton_tshirt", "cotton_hoodie", "silicone_phone_case_blank"] },
  { key: "leather_stamping", name: "Leather stamping", accepts: ["leather_wallet_blank", "leather_belt_blank"] },
  // Furniture / appliance / outdoor transforms
  { key: "varnishing", name: "Varnishing", accepts: ["wood_table_top_blank", "wood_cutting_board_blank"] },
  { key: "powder_coating", name: "Powder coating", accepts: ["metal_chair_frame_blank", "steel_shelf_bracket_blank", "bike_frame_blank"] },
  { key: "upholstering", name: "Upholstering", accepts: ["metal_chair_frame_blank"] },
  { key: "assembly_electronics", name: "Electronics assembly", accepts: ["speaker_casing_blank", "mini_fridge_shell_blank"] },
  { key: "anodizing", name: "Anodizing", accepts: ["bike_frame_blank", "metal_water_bottle_blank", "garden_planter_blank"] },
  // Beauty / office transforms
  { key: "soap_molding", name: "Soap molding and scenting", accepts: ["soap_bar_blank"] },
  { key: "debossing", name: "Debossing", accepts: ["notebook_cover_blank", "leather_wallet_blank", "leather_belt_blank"] },
];

const FULFILLMENT = { key: "assembly_and_packaging", name: "Assembly and packaging" };

type ProductStep =
  | { kind: "SUPPLY"; materialKey: string }
  | { kind: "TRANSFORM"; transformKey: string };

type Product = { name: string; steps: ProductStep[] };

function buildProducts(): Product[] {
  const products: Product[] = [];

  // Single material -> single compatible transform -> fulfillment.
  for (const t of TRANSFORMS) {
    for (const materialKey of t.accepts) {
      const material = MATERIALS.find((m) => m.key === materialKey)!;
      products.push({
        name: `${t.name} ${material.name.replace(" blank", "")}`,
        steps: [{ kind: "SUPPLY", materialKey }, { kind: "TRANSFORM", transformKey: t.key }],
      });
    }
  }

  // Two-transform variants for a handful of apparel items (real multi-step
  // products: e.g. dye it, then embroider it).
  const twoStepCombos: [string, string, string][] = [
    ["cotton_hoodie", "dyeing", "embroidery"],
    ["cotton_tshirt", "dyeing", "screen_printing"],
    ["canvas_tote_bag", "dyeing", "embroidery"],
    ["denim_jacket", "dyeing", "embroidery"],
    ["cotton_hoodie", "screen_printing", "heat_pressing"],
    ["ceramic_mug_blank", "hand_painting", "uv_printing"],
    ["leather_wallet_blank", "leather_stamping", "engraving"],
    ["metal_water_bottle_blank", "engraving", "uv_printing"],
    ["acrylic_keychain_blank", "laser_cutting", "uv_printing"],
  ];
  for (const [materialKey, t1, t2] of twoStepCombos) {
    const material = MATERIALS.find((m) => m.key === materialKey)!;
    const tr1 = TRANSFORMS.find((t) => t.key === t1)!;
    const tr2 = TRANSFORMS.find((t) => t.key === t2)!;
    products.push({
      name: `${tr1.name} + ${tr2.name} ${material.name.replace(" blank", "")}`,
      steps: [
        { kind: "SUPPLY", materialKey },
        { kind: "TRANSFORM", transformKey: t1 },
        { kind: "TRANSFORM", transformKey: t2 },
      ],
    });
  }

  // Bundle products: two independent materials each needing their own
  // transform, combined at fulfillment. These are the ones that genuinely
  // require visiting multiple different stores for different materials.
  const bundles: [string, string, string, string, string][] = [
    ["ceramic_mug_blank", "uv_printing", "candle_wax_blank", "hand_painting", "Mug + candle gift set"],
    ["leather_wallet_blank", "engraving", "leather_belt_blank", "leather_stamping", "Wallet + belt leather set"],
    ["acrylic_keychain_blank", "laser_cutting", "canvas_tote_bag", "embroidery", "Keychain + tote bundle"],
    ["cotton_tshirt", "screen_printing", "vinyl_sticker_sheet_blank", "vinyl_cutting", "Shirt + sticker pack"],
    ["metal_water_bottle_blank", "uv_printing", "silicone_phone_case_blank", "uv_printing", "Bottle + phone case set"],
    ["cotton_tshirt", "screen_printing", "canvas_tote_bag", "embroidery", "Shirt + tote combo"],
    ["denim_jacket", "embroidery", "leather_wallet_blank", "engraving", "Jacket + wallet gift set"],
    ["wood_cutting_board_blank", "engraving", "ceramic_mug_blank", "uv_printing", "Board + mug kitchen set"],
    ["glass_ornament_blank", "hand_painting", "candle_wax_blank", "hand_painting", "Ornament + candle holiday set"],
    ["paper_poster_blank", "screen_printing", "vinyl_sticker_sheet_blank", "vinyl_cutting", "Poster + sticker pack"],
    ["metal_chair_frame_blank", "upholstering", "wood_table_top_blank", "varnishing", "Dining table + chair set"],
    ["mini_fridge_shell_blank", "assembly_electronics", "steel_shelf_bracket_blank", "powder_coating", "Mini fridge + shelf bracket kit"],
    ["speaker_casing_blank", "assembly_electronics", "bike_frame_blank", "anodizing", "Speaker + bike accessory bundle"],
    ["garden_planter_blank", "anodizing", "glass_lamp_shade_blank", "hand_painting", "Planter + lamp shade patio set"],
    ["wood_cutting_board_blank", "varnishing", "steel_shelf_bracket_blank", "powder_coating", "Board + shelf bracket kitchen kit"],
    // Beauty / pet / office / sports / baby markets, each paired with a
    // second, unrelated category so the bundle genuinely spans two markets.
    ["soap_bar_blank", "soap_molding", "candle_wax_blank", "hand_painting", "Spa gift set (soap + candle)"],
    ["pet_bandana_blank", "embroidery", "ceramic_mug_blank", "uv_printing", "Pet parent bundle (bandana + mug)"],
    ["notebook_cover_blank", "debossing", "leather_wallet_blank", "leather_stamping", "Executive desk set (notebook + wallet)"],
    ["yoga_mat_blank", "screen_printing", "metal_water_bottle_blank", "engraving", "Wellness kit (yoga mat + bottle)"],
    ["baby_onesie_blank", "embroidery", "wood_cutting_board_blank", "engraving", "New parent gift set (onesie + keepsake board)"],
  ];
  for (const [mat1, t1, mat2, t2, bundleName] of bundles) {
    products.push({
      name: bundleName,
      steps: [
        { kind: "SUPPLY", materialKey: mat1 },
        { kind: "TRANSFORM", transformKey: t1 },
        { kind: "SUPPLY", materialKey: mat2 },
        { kind: "TRANSFORM", transformKey: t2 },
      ],
    });
  }

  // The actual pitch-deck demo product: a multi-material, multi-transform,
  // multi-store bundle matching the "200 onboarding kits" example exactly --
  // hoodie (material + embroidery transform), bottle (material + engraving
  // transform), snacks (material only, no transform), packaging (material
  // only, no transform), then one fulfillment merchant assembles all four.
  products.push({
    name: "Corporate onboarding kit (embroidered hoodie + engraved bottle + vegan snacks + custom packaging)",
    steps: [
      { kind: "SUPPLY", materialKey: "cotton_hoodie" },
      { kind: "TRANSFORM", transformKey: "embroidery" },
      { kind: "SUPPLY", materialKey: "metal_water_bottle_blank" },
      { kind: "TRANSFORM", transformKey: "engraving" },
      { kind: "SUPPLY", materialKey: "vegan_snack_pack" },
      { kind: "SUPPLY", materialKey: "custom_packaging_blank" },
    ],
  });

  // A few more direct-to-fulfillment bundles mixing materials that don't
  // need a transform (snacks, packaging) with ones that do -- more markets,
  // more store combinations.
  products.push({
    name: "Self-care and snack gift box (soap + snacks + custom packaging)",
    steps: [
      { kind: "SUPPLY", materialKey: "soap_bar_blank" },
      { kind: "TRANSFORM", transformKey: "soap_molding" },
      { kind: "SUPPLY", materialKey: "vegan_snack_pack" },
      { kind: "SUPPLY", materialKey: "custom_packaging_blank" },
    ],
  });
  products.push({
    name: "New hire swag box (hoodie + notebook + water bottle + packaging)",
    steps: [
      { kind: "SUPPLY", materialKey: "cotton_hoodie" },
      { kind: "TRANSFORM", transformKey: "screen_printing" },
      { kind: "SUPPLY", materialKey: "notebook_cover_blank" },
      { kind: "TRANSFORM", transformKey: "debossing" },
      { kind: "SUPPLY", materialKey: "metal_water_bottle_blank" },
      { kind: "TRANSFORM", transformKey: "engraving" },
      { kind: "SUPPLY", materialKey: "custom_packaging_blank" },
    ],
  });
  products.push({
    name: "Pet + human matching gift set (bandana + tote + snacks)",
    steps: [
      { kind: "SUPPLY", materialKey: "pet_bandana_blank" },
      { kind: "TRANSFORM", transformKey: "embroidery" },
      { kind: "SUPPLY", materialKey: "canvas_tote_bag" },
      { kind: "TRANSFORM", transformKey: "embroidery" },
      { kind: "SUPPLY", materialKey: "vegan_snack_pack" },
    ],
  });

  return products;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}
function pick<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

// Unit price ranges (CAD) per material category, grounded in real wholesale
// blank/component pricing researched from actual supplier listings (not
// finished-retail prices -- these are blanks/components before any
// transform, same as what a real Shopify merchant would list):
//  - apparel: blank hoodies run $6.50-14/unit wholesale (Closo wholesale
//    pricing guide); tees/totes cheaper, denim jackets pricier -- bucket
//    spans that range.
//  - leather: blank leather wallets run ~$3.75-15/unit in bulk (El Paso
//    Saddleblanket, SupplyLeader wallet listings).
//  - ceramic/glass/acrylic/vinyl/silicone: sublimation/blank craft supply
//    listings (Coastal Business, AllDayShirts, PYD Life) put 11oz mug
//    blanks, ornament blanks, keychain/sticker/case blanks in the
//    $0.50-5/unit range in bulk packs.
//  - furniture/appliance/electronics/outdoor/lighting: priced as raw
//    components/frames/shells (what these _blank materials actually are),
//    not finished consumer goods -- component-level wholesale is a fraction
//    of retail.
const CATEGORY_PRICE_RANGE: Record<string, [number, number]> = {
  apparel: [5, 35],
  leather: [4, 20],
  ceramic: [1, 6],
  glass: [1, 8],
  acrylic: [1, 5],
  wood: [5, 80],
  metal: [3, 20],
  silicone: [1, 5],
  vinyl: [1, 4],
  wax: [2, 10],
  paper: [1, 5],
  furniture: [20, 150],
  appliance: [30, 120],
  electronics: [5, 30],
  outdoor: [10, 150],
  lighting: [8, 40],
  // Grounded in Packed with Purpose's real vegan pretzel braids ($5/5oz
  // bag) scaled to a multi-item onboarding-kit snack pack.
  food: [4, 15],
  // Grounded in Brandable Box / G10 Fulfillment real branded-box pricing --
  // a logo shipping box runs a couple dollars at volume.
  packaging: [1, 8],
  beauty: [2, 8],
  pet: [3, 12],
  office: [2, 10],
  sports: [8, 30],
  baby: [4, 18],
};
function materialPriceRange(category: string): [number, number] {
  return CATEGORY_PRICE_RANGE[category] ?? [4, 40];
}

// Realistic-sounding filler store names for competitors that aren't one of
// the REAL_MERCHANTS below -- avoids the catalog reading as "Catalog Store
// 47" placeholders once real names run out for a given capability.
const NAME_PREFIXES = [
  "North", "Coastal", "Union", "Maple", "Harbor", "Foundry", "Thistle", "Cedar",
  "Ironwood", "Bramble", "Summit", "Alder", "Birchwood", "Lantern", "Anchor",
  "Meridian", "Hollow", "Quarry", "Stonegate", "Willow",
];
const NAME_SUFFIXES = [
  "& Co.", "Supply Co.", "Goods", "Works", "Studio", "Collective", "Trading Co.",
  "Provisions", "Makers", "Workshop", "Partners", "Outfitters",
];
function generateStoreName(seedIndex: number): string {
  const prefix = NAME_PREFIXES[seedIndex % NAME_PREFIXES.length];
  const suffix = NAME_SUFFIXES[Math.floor(seedIndex / NAME_PREFIXES.length) % NAME_SUFFIXES.length];
  return `${prefix} ${suffix}`;
}

// Per-transform price ranges (CAD): unit price and setup fee. Embroidery and
// screen printing are grounded directly in researched small-batch service
// pricing (The Apparel Factory, Rolled Up Tees); the rest are estimated at
// the same order of magnitude from general finishing/service industry
// pricing since exact per-unit rates for those services aren't published
// the way embroidery/screen-printing rates are.
const TRANSFORM_PRICE_RANGE: Record<string, { unit: [number, number]; setup: [number, number] }> = {
  embroidery: { unit: [6, 14], setup: [25, 50] }, // grounded: small-batch (12-50pc) embroidery rates
  screen_printing: { unit: [3, 18], setup: [5, 20] }, // grounded: per-shirt cost scales with volume
  engraving: { unit: [2, 8], setup: [15, 40] },
  laser_cutting: { unit: [3, 10], setup: [20, 50] },
  dyeing: { unit: [4, 12], setup: [10, 25] },
  uv_printing: { unit: [2, 8], setup: [15, 35] },
  vinyl_cutting: { unit: [1, 5], setup: [10, 20] },
  hand_painting: { unit: [5, 20], setup: [0, 10] },
  heat_pressing: { unit: [2, 8], setup: [5, 15] },
  leather_stamping: { unit: [3, 10], setup: [10, 25] },
  varnishing: { unit: [5, 15], setup: [10, 20] },
  powder_coating: { unit: [8, 25], setup: [20, 50] },
  upholstering: { unit: [40, 150], setup: [0, 20] },
  assembly_electronics: { unit: [5, 20], setup: [20, 60] },
  anodizing: { unit: [5, 20], setup: [20, 50] },
  soap_molding: { unit: [2, 6], setup: [5, 15] },
  debossing: { unit: [2, 7], setup: [10, 20] },
};
function transformPriceRange(key: string): { unit: [number, number]; setup: [number, number] } {
  return TRANSFORM_PRICE_RANGE[key] ?? { unit: [3, 20], setup: [10, 40] };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Export it before running this script.");
  }

  const products = buildProducts();
  process.stdout.write(`Built ${products.length} product definitions.\n`);

  // Collect the distinct capability "slots" that need providers: every
  // material, every transform, plus fulfillment.
  const materialKeys = new Set(products.flatMap((p) => p.steps.filter((s) => s.kind === "SUPPLY").map((s) => (s as any).materialKey)));
  const transformKeys = new Set(products.flatMap((p) => p.steps.filter((s) => s.kind === "TRANSFORM").map((s) => (s as any).transformKey)));

  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`set synchronous_commit = off;`);

  let merchantCounter = 1;
  const usedNames = new Set<string>();
  const merchants: { merchantId: string; name: string }[] = [];
  function newMerchant(preferredName?: string): { merchantId: string; name: string } {
    const id = `m-catalog-${String(merchantCounter).padStart(3, "0")}`;
    let name = preferredName;
    if (!name || usedNames.has(name)) {
      name = generateStoreName(merchantCounter);
      while (usedNames.has(name)) {
        merchantCounter += 1;
        name = generateStoreName(merchantCounter);
      }
    }
    usedNames.add(name);
    merchantCounter += 1;
    const m = { merchantId: id, name };
    merchants.push(m);
    return m;
  }

  const catalogReference: any = { materials: [], transforms: [], fulfillment: [], products: [] };

  try {
    await client.query("begin");

    // Materials: 2-6 competing merchants per material.
    for (const key of materialKeys) {
      const material = MATERIALS.find((m) => m.key === key)!;
      const realNames = REAL_MERCHANTS[key] ?? [];
      const providerCount = Math.max(randInt(2, 6), realNames.length);
      const entry: any = { material: material.name, providers: [] };
      const [priceMin, priceMax] = materialPriceRange(material.category);
      for (let i = 0; i < providerCount; i++) {
        const merchant = newMerchant(realNames[i]?.name);
        const unitPrice = Number(rand(priceMin, priceMax).toFixed(2));
        const setupFee = Number(rand(0, priceMax * 0.4).toFixed(2));
        const leadMin = randInt(2, 24);
        const leadMax = leadMin + randInt(4, 48);
        const capacity = randInt(50, 1000);
        const capabilityId = `cap-${merchant.merchantId}-${material.key}`;
        await client.query(
          `insert into merchants (merchant_id, name) values ($1, $2) on conflict (merchant_id) do nothing;`,
          [merchant.merchantId, merchant.name],
        );
        const capabilityJson = {
          capabilityId,
          merchantId: merchant.merchantId,
          kind: "SUPPLY",
          name: material.name,
          description: `${material.name} supplied by ${merchant.name}`,
          accepts: [],
          produces: [{ kind: "material", name: material.key, attributes: { category: material.category } }],
          quantity: { min: 1, max: capacity, unit: "unit" },
          pricing: { currency: "CAD", unitPrice, setupFee },
          leadTime: { min: leadMin, max: leadMax, unit: "hours" },
          capacity: { available: capacity, maximum: capacity, period: "week" },
          hardRules: [],
          softRules: [],
          sourceClaimIds: [],
        };
        await client.query(
          `insert into capabilities (capability_id, merchant_id, kind, name, description, capability_json)
           values ($1, $2, 'SUPPLY', $3, $4, $5)
           on conflict (capability_id) do nothing;`,
          [capabilityId, merchant.merchantId, material.name, capabilityJson.description, JSON.stringify(capabilityJson)],
        );
        entry.providers.push({ merchantId: merchant.merchantId, merchantName: merchant.name, unitPrice, leadMin, leadMax, capacity });
      }
      catalogReference.materials.push(entry);
    }

    // Transforms: 2-6 competing merchants per transform.
    for (const key of transformKeys) {
      const transform = TRANSFORMS.find((t) => t.key === key)!;
      const realNames = REAL_MERCHANTS[key] ?? [];
      const providerCount = Math.max(randInt(2, 6), realNames.length);
      const entry: any = { transform: transform.name, providers: [] };
      const { unit: [tUnitMin, tUnitMax], setup: [tSetupMin, tSetupMax] } = transformPriceRange(key);
      for (let i = 0; i < providerCount; i++) {
        const merchant = newMerchant(realNames[i]?.name);
        const unitPrice = Number(rand(tUnitMin, tUnitMax).toFixed(2));
        const setupFee = Number(rand(tSetupMin, tSetupMax).toFixed(2));
        const leadMin = randInt(4, 24);
        const leadMax = leadMin + randInt(8, 72);
        const capacity = randInt(10, 200);
        const capabilityId = `cap-${merchant.merchantId}-${transform.key}`;
        await client.query(
          `insert into merchants (merchant_id, name) values ($1, $2) on conflict (merchant_id) do nothing;`,
          [merchant.merchantId, merchant.name],
        );
        const capabilityJson = {
          capabilityId,
          merchantId: merchant.merchantId,
          kind: "TRANSFORM",
          name: transform.name,
          description: `${transform.name} offered by ${merchant.name}`,
          accepts: transform.accepts.map((materialKey) => ({ kind: "material", name: materialKey, attributes: {} })),
          produces: [{ kind: "material", name: `${transform.key}_output`, attributes: {} }],
          quantity: { min: 1, max: capacity, unit: "unit" },
          pricing: { currency: "CAD", unitPrice, setupFee },
          leadTime: { min: leadMin, max: leadMax, unit: "hours" },
          capacity: { available: capacity, maximum: capacity, period: "day" },
          hardRules: [],
          softRules: [],
          sourceClaimIds: [],
        };
        await client.query(
          `insert into capabilities (capability_id, merchant_id, kind, name, description, capability_json)
           values ($1, $2, 'TRANSFORM', $3, $4, $5)
           on conflict (capability_id) do nothing;`,
          [capabilityId, merchant.merchantId, transform.name, capabilityJson.description, JSON.stringify(capabilityJson)],
        );
        entry.providers.push({ merchantId: merchant.merchantId, merchantName: merchant.name, unitPrice, leadMin, leadMax, capacity });
      }
      catalogReference.transforms.push(entry);
    }

    // Fulfillment: several generic packers, any of them can finish any order.
    const fulfillmentProviderCount = randInt(6, 12);
    const fulfillmentEntry: any = { fulfillment: FULFILLMENT.name, providers: [] };
    for (let i = 0; i < fulfillmentProviderCount; i++) {
      const merchant = newMerchant();
      const unitPrice = Number(rand(1.5, 6).toFixed(2));
      const setupFee = Number(rand(0, 10).toFixed(2));
      const leadMin = randInt(2, 12);
      const leadMax = leadMin + randInt(4, 24);
      const capacity = randInt(200, 2000);
      const capabilityId = `cap-${merchant.merchantId}-${FULFILLMENT.key}`;
      await client.query(
        `insert into merchants (merchant_id, name) values ($1, $2) on conflict (merchant_id) do nothing;`,
        [merchant.merchantId, merchant.name],
      );
      const capabilityJson = {
        capabilityId,
        merchantId: merchant.merchantId,
        kind: "FULFILL",
        name: FULFILLMENT.name,
        description: `Final assembly and packaging by ${merchant.name}`,
        accepts: [{ kind: "material", name: "any", attributes: {} }],
        produces: [{ kind: "package", name: "shipped_order", attributes: {} }],
        quantity: { min: 1, max: capacity, unit: "unit" },
        pricing: { currency: "CAD", unitPrice, setupFee },
        leadTime: { min: leadMin, max: leadMax, unit: "hours" },
        capacity: { available: capacity, maximum: capacity, period: "week" },
        hardRules: [],
        softRules: [],
        sourceClaimIds: [],
      };
      await client.query(
        `insert into capabilities (capability_id, merchant_id, kind, name, description, capability_json)
         values ($1, $2, 'FULFILL', $3, $4, $5)
         on conflict (capability_id) do nothing;`,
        [capabilityId, merchant.merchantId, FULFILLMENT.name, capabilityJson.description, JSON.stringify(capabilityJson)],
      );
      fulfillmentEntry.providers.push({ merchantId: merchant.merchantId, merchantName: merchant.name, unitPrice, leadMin, leadMax, capacity });
    }
    catalogReference.fulfillment.push(fulfillmentEntry);

    // If we're short of 100 merchants, top up with extra competing
    // providers on random materials so the store count lands near 100.
    while (merchants.length < 100) {
      const material = MATERIALS[randInt(0, MATERIALS.length - 1)]!;
      const merchant = newMerchant();
      const [topUpMin, topUpMax] = materialPriceRange(material.category);
      const unitPrice = Number(rand(topUpMin, topUpMax).toFixed(2));
      const capacity = randInt(50, 1000);
      const capabilityId = `cap-${merchant.merchantId}-${material.key}`;
      await client.query(
        `insert into merchants (merchant_id, name) values ($1, $2) on conflict (merchant_id) do nothing;`,
        [merchant.merchantId, merchant.name],
      );
      const capabilityJson = {
        capabilityId,
        merchantId: merchant.merchantId,
        kind: "SUPPLY",
        name: material.name,
        description: `${material.name} supplied by ${merchant.name}`,
        accepts: [],
        produces: [{ kind: "material", name: material.key, attributes: { category: material.category } }],
        quantity: { min: 1, max: capacity, unit: "unit" },
        pricing: { currency: "CAD", unitPrice, setupFee: Number(rand(0, topUpMax * 0.4).toFixed(2)) },
        leadTime: { min: randInt(2, 24), max: randInt(24, 72), unit: "hours" },
        capacity: { available: capacity, maximum: capacity, period: "week" },
        hardRules: [],
        softRules: [],
        sourceClaimIds: [],
      };
      await client.query(
        `insert into capabilities (capability_id, merchant_id, kind, name, description, capability_json)
         values ($1, $2, 'SUPPLY', $3, $4, $5)
         on conflict (capability_id) do nothing;`,
        [capabilityId, merchant.merchantId, material.name, capabilityJson.description, JSON.stringify(capabilityJson)],
      );
    }

    catalogReference.products = products.map((p) => ({
      name: p.name,
      steps: p.steps.map((s) => (s.kind === "SUPPLY" ? { supply: (s as any).materialKey } : { transform: (s as any).transformKey })),
    }));

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    await client.end();
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(here, "..", "..", "catalog-reference.json");
  writeFileSync(outPath, JSON.stringify(catalogReference, null, 2));

  process.stdout.write(`Done. Created ${merchants.length} merchants across materials/transforms/fulfillment.\n`);
  process.stdout.write(`${products.length} product definitions written to packages/db/catalog-reference.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
