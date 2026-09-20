import {
  catalogFor,
  releaseCatalogFor,
  roleForStore,
  DEMO_STORE_HANDLES,
} from "@molecule/test-fixtures";
import { digest, ShopifyError } from "../types.js";

/**
 * Synthetic Shopify store state for the local fake Admin API.
 *
 * Seeded from the SAME deterministic fixtures as `scripts/seed-shopify.mjs` and
 * `MockShopifyAdapter`, so the fake, the in-memory catalog mock and a real seeded dev store
 * all start from identical data. Nothing here is an operational claim about a real merchant:
 * every product keeps the `MOLECULE_DEMO` label required by
 * docs/TASKS/SHOPIFY_DATA_PIPELINE.md section 2.
 *
 * Identifiers deliberately use the real `gid://shopify/...` prefixes because `adminUrl()`,
 * `seed.ts` and the inventory webhook payloads all validate against them.
 */

export interface FakeVariant {
  id: string;
  sku: string;
  title: string;
  price: string;
  selectedOptions: { name: string; value: string }[];
  inventoryItemId: string;
  tracked: boolean;
  /** null means Shopify holds no tracked quantity: an unknown, not a zero. */
  quantity: number | null;
}

export interface FakeProduct {
  id: string;
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  status: string;
  descriptionHtml: string;
  tags: string[];
  options: { name: string; position: number; values: string[] }[];
  variants: FakeVariant[];
  metafields: Map<string, { namespace: string; key: string; value: string }>;
}

export interface FakeDraftOrder {
  id: string;
  invoiceUrl: string;
  status: string;
  tags: string[];
  customAttributes: { key: string; value: string }[];
  lineItems: {
    title: string;
    quantity: number;
    sku?: string;
    variantId?: string;
    amount: string;
  }[];
  currencyCode: string;
  totalAmount: string;
}

export interface FakeOrderLineItem {
  id: string;
  title: string;
  quantity: number;
  sku: string;
  variantId: string;
  productId: string;
  unitPrice: string;
  totalPrice: string;
}

export interface FakeOrder {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  currencyCode: string;
  subtotal: string;
  totalAmount: string;
  customerId: string;
  tags: string[];
  lineItems: FakeOrderLineItem[];
}

export interface FakeCustomer {
  id: string;
  displayName: string;
  email: string;
  createdAt: string;
  numberOfOrders: number;
  amountSpent: string;
  currencyCode: string;
  tags: string[];
}

export interface FakeLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface FakeStore {
  domain: string;
  handle: string;
  role: string;
  name: string;
  currencyCode: string;
  locations: FakeLocation[];
  /** Keyed by product handle. */
  products: Map<string, FakeProduct>;
  draftOrders: Map<string, FakeDraftOrder>;
  orders: Map<string, FakeOrder>;
  customers: Map<string, FakeCustomer>;
  metafieldDefinitions: Map<string, { namespace: string; key: string }>;
  /** Results of `@idempotent(key:)` mutations, replayed instead of re-applied. */
  idempotency: Map<string, { fingerprint: string; result: unknown }>;
}

/** FNV-1a, matching the generator style in packages/test-fixtures/src/seed-data.mjs. */
function hashStr(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. Seeded per store so order/customer generation is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export interface FakeSeedOptions {
  stores?: readonly string[];
  catalogProfile?: "broad" | "release";
  /** Clock for generated orders and customers. Fixed by default for determinism. */
  now?: Date;
  /** Days of order history to generate per supplier store. */
  orderHistoryDays?: number;
  /** First numeric identifier. Tests that assert literal GIDs set this to 1. */
  idStart?: number;
  /** Skip catalog seeding. Used by durable-execution tests that create everything by mutation. */
  seedCatalog?: boolean;
  /** Skip synthetic order/customer generation. */
  seedCommerce?: boolean;
}

export const FAKE_CLOCK = "2026-09-19T12:00:00.000Z";

export function normalizeDomain(input: string): string {
  const value = input.trim().toLowerCase();
  return value.endsWith(".myshopify.com") ? value : `${value}.myshopify.com`;
}

export function storeHandle(domain: string): string {
  return normalizeDomain(domain).split(".")[0]!;
}

/**
 * Deterministic numeric identifier allocator. Every store draws from the same sequence so a
 * product GID is unique across the whole fake world, mirroring how Shopify IDs never collide.
 */
export class IdSequence {
  private readonly counters = new Map<string, number>();
  constructor(private readonly start = 1_000_000) {}
  take(kind: string): number {
    const next = this.counters.get(kind) ?? this.start;
    this.counters.set(kind, next + 1);
    return next;
  }
}

export function seedStore(
  domain: string,
  ids: IdSequence,
  options: FakeSeedOptions = {},
): FakeStore {
  const normalized = normalizeDomain(domain);
  const handle = storeHandle(normalized);
  const role = roleForStore(handle);
  const catalog =
    options.catalogProfile === "release" ? releaseCatalogFor : catalogFor;
  // An empty catalog is legitimate: `releaseCatalogFor` deliberately returns nothing for roles
  // whose products are created by approved plan execution rather than seeding. Match
  // MockShopifyAdapter and leave the store empty rather than refusing to build it.
  const source = catalog(role) as CatalogFixtureProduct[];

  const store: FakeStore = {
    domain: normalized,
    handle,
    role,
    name: `${handle} (synthetic)`,
    currencyCode: "CAD",
    locations: [
      {
        id: `gid://shopify/Location/${ids.take("Location")}`,
        name: "Synthetic primary location",
        isActive: true,
      },
    ],
    products: new Map(),
    draftOrders: new Map(),
    orders: new Map(),
    customers: new Map(),
    metafieldDefinitions: new Map(),
    idempotency: new Map(),
  };

  if (options.seedCatalog !== false) {
    for (const product of source) {
      store.products.set(product.handle, buildProduct(product, ids));
    }
  }

  if (options.seedCommerce !== false) seedCommerce(store, ids, options);
  return store;
}

interface CatalogFixtureProduct {
  handle: string;
  title: string;
  type: string;
  vendor: string;
  descriptionHtml: string;
  tags: string[];
  options?: Record<string, string[]> | null;
  variants: {
    optionValues: { optionName: string; name: string }[];
    price: string;
    sku: string;
    tracked: boolean;
    quantity: number | null;
  }[];
}

function buildProduct(
  source: CatalogFixtureProduct,
  ids: IdSequence,
): FakeProduct {
  const optionEntries = Object.entries(
    source.options ?? { Title: ["Default Title"] },
  );
  return {
    id: `gid://shopify/Product/${ids.take("Product")}`,
    handle: source.handle,
    title: source.title,
    vendor: source.vendor,
    productType: source.type,
    status: "ACTIVE",
    descriptionHtml: source.descriptionHtml,
    tags: [...source.tags],
    options: optionEntries.map(([name, values], index) => ({
      name,
      position: index + 1,
      values: [...values],
    })),
    variants: source.variants.map((variant) => {
      const numeric = ids.take("Variant");
      return {
        id: `gid://shopify/ProductVariant/${numeric}`,
        sku: variant.sku,
        title: variant.optionValues.map((option) => option.name).join(" / "),
        price: variant.price,
        selectedOptions: variant.optionValues.map((option) => ({
          name: option.optionName,
          value: option.name,
        })),
        // Shares the variant's numeric suffix so inventory webhook payloads stay matchable,
        // exactly as MockShopifyAdapter derives it.
        inventoryItemId: `gid://shopify/InventoryItem/${numeric}`,
        tracked: variant.tracked,
        quantity: variant.quantity,
      };
    }),
    metafields: new Map(),
  };
}

const FIRST_NAMES = [
  "Avery",
  "Rowan",
  "Quinn",
  "Sasha",
  "Devon",
  "Marlowe",
  "Emerson",
  "Kai",
  "Reese",
  "Harper",
  "Nico",
  "Sage",
];
const LAST_NAMES = [
  "Okonkwo",
  "Lindqvist",
  "Barros",
  "Nakamura",
  "Duval",
  "Ferreira",
  "Haddad",
  "Novak",
  "Osei",
  "Villanueva",
];
const FULFILLMENT = ["FULFILLED", "UNFULFILLED", "PARTIALLY_FULFILLED"];
const FINANCIAL = ["PAID", "PENDING", "PARTIALLY_REFUNDED"];

/**
 * Generates synthetic customers and order history from the store's own seeded catalog, so the
 * console's orders and analytics are internally consistent with its products. These records
 * have no live counterpart (`read_customers` is not a granted scope) and are display-only:
 * nothing here is read by Reality, the solver, or claim resolution.
 */
function seedCommerce(
  store: FakeStore,
  ids: IdSequence,
  options: FakeSeedOptions,
): void {
  const sellable = [...store.products.values()].filter(
    (product) => product.variants.length > 0,
  );
  if (!sellable.length) return;

  const random = rng(hashStr(store.domain));
  const now = options.now ?? new Date(FAKE_CLOCK);
  const days = options.orderHistoryDays ?? 45;
  const customerCount = 6 + Math.floor(random() * 6);

  const customers: FakeCustomer[] = [];
  for (let index = 0; index < customerCount; index++) {
    const first = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]!;
    const last = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]!;
    const id = `gid://shopify/Customer/${ids.take("Customer")}`;
    customers.push({
      id,
      displayName: `${first} ${last}`,
      // .invalid is reserved by RFC 2606 and can never route to a real inbox.
      email:
        `${first}.${last}.${digest(id).slice(0, 6)}@synthetic.invalid`.toLowerCase(),
      createdAt: new Date(
        now.getTime() - Math.floor(random() * days * 2) * 86_400_000,
      ).toISOString(),
      numberOfOrders: 0,
      amountSpent: "0.00",
      currencyCode: store.currencyCode,
      tags: ["MOLECULE_DEMO", "synthetic"],
    });
  }

  const orderCount = 18 + Math.floor(random() * 18);
  for (let index = 0; index < orderCount; index++) {
    const customer = customers[Math.floor(random() * customers.length)]!;
    const placedAt = new Date(
      now.getTime() - Math.floor(random() * days) * 86_400_000,
    );
    const lineCount = 1 + Math.floor(random() * 3);
    const lineItems: FakeOrderLineItem[] = [];
    let subtotal = 0;
    for (let line = 0; line < lineCount; line++) {
      const product = sellable[Math.floor(random() * sellable.length)]!;
      const variant =
        product.variants[Math.floor(random() * product.variants.length)]!;
      const quantity = 1 + Math.floor(random() * 25);
      const unit = Number(variant.price);
      const total = unit * quantity;
      subtotal += total;
      lineItems.push({
        id: `gid://shopify/LineItem/${ids.take("LineItem")}`,
        title: product.title,
        quantity,
        sku: variant.sku,
        variantId: variant.id,
        productId: product.id,
        unitPrice: money(unit),
        totalPrice: money(total),
      });
    }
    const id = `gid://shopify/Order/${ids.take("Order")}`;
    customer.numberOfOrders += 1;
    customer.amountSpent = money(Number(customer.amountSpent) + subtotal);
    store.orders.set(id, {
      id,
      name: `#${1001 + index}`,
      createdAt: placedAt.toISOString(),
      processedAt: placedAt.toISOString(),
      displayFinancialStatus:
        FINANCIAL[Math.floor(random() * FINANCIAL.length)]!,
      displayFulfillmentStatus:
        FULFILLMENT[Math.floor(random() * FULFILLMENT.length)]!,
      currencyCode: store.currencyCode,
      subtotal: money(subtotal),
      totalAmount: money(subtotal),
      customerId: customer.id,
      tags: ["MOLECULE_DEMO", "synthetic"],
      lineItems,
    });
  }

  for (const customer of customers) store.customers.set(customer.id, customer);
}

export function seedWorld(
  options: FakeSeedOptions = {},
): Map<string, FakeStore> {
  const handles = options.stores ?? DEMO_STORE_HANDLES;
  if (!handles.length) throw new ShopifyError("NO_FAKE_STORES");
  const ids = new IdSequence(options.idStart);
  const stores = new Map<string, FakeStore>();
  for (const handle of handles) {
    const store = seedStore(handle, ids, options);
    stores.set(store.domain, store);
  }
  return stores;
}
