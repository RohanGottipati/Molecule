import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eventFor, type ShopifyActionRepository } from "./repository.js";
import { shopDomain } from "./transport.js";
import { digest, ShopifyError } from "./types.js";

export function verifyWebhookHmac(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export interface WebhookOptions {
  secret: string;
  allowedDomains: string[];
  repository: ShopifyActionRepository;
  maxBodyBytes?: number;
}

export async function handleShopifyWebhook(
  options: WebhookOptions,
  input: { rawBody: Uint8Array; headers: Record<string, string | undefined> },
): Promise<{ status: "accepted" | "duplicate"; eventId: string }> {
  if (input.rawBody.byteLength > (options.maxBodyBytes ?? 1_000_000))
    throw new ShopifyError("WEBHOOK_TOO_LARGE");
  const signature = input.headers["x-shopify-hmac-sha256"] ?? "";
  if (!verifyWebhookHmac(input.rawBody, signature, options.secret))
    throw new ShopifyError("WEBHOOK_UNAUTHORIZED");
  const domain = shopDomain(input.headers["x-shopify-shop-domain"] ?? "");
  if (!options.allowedDomains.map(shopDomain).includes(domain))
    throw new ShopifyError("WEBHOOK_UNAUTHORIZED");
  const topic = input.headers["x-shopify-topic"] ?? "";
  if (
    ![
      "inventory_levels/update",
      "products/update",
      "draft_orders/update",
      "orders/create",
      "app/uninstalled",
    ].includes(topic)
  ) {
    throw new ShopifyError("WEBHOOK_TOPIC_NOT_SUPPORTED");
  }
  const deliveryId = input.headers["x-shopify-webhook-id"] ?? "";
  if (!z.uuid().safeParse(deliveryId).success)
    throw new ShopifyError("WEBHOOK_INVALID_ID");
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
  } catch {
    throw new ShopifyError("WEBHOOK_INVALID_JSON");
  }
  const parsed = z
    .object({
      id: z.union([z.string(), z.number().int().safe()]).optional(),
      admin_graphql_api_id: z.string().optional(),
      inventory_item_id: z
        .union([z.string(), z.number().int().safe()])
        .optional(),
      location_id: z.union([z.string(), z.number().int().safe()]).optional(),
      available: z.number().int().nullable().optional(),
    })
    .safeParse(body);
  if (!parsed.success) throw new ShopifyError("WEBHOOK_INVALID_PAYLOAD");
  const event = eventFor(
    `shopify-webhook:${deliveryId}`,
    `shopify.webhook.${topic.replaceAll("/", ".")}`,
    { domain, topic, deliveryId, ...parsed.data },
  );
  const eventHash = digest([domain, deliveryId]);
  event.eventId = `${eventHash.slice(0, 8)}-${eventHash.slice(8, 12)}-4${eventHash.slice(13, 16)}-a${eventHash.slice(17, 20)}-${eventHash.slice(20, 32)}`;
  const status = await options.repository.recordWebhook(
    domain,
    deliveryId,
    digest([topic, Buffer.from(input.rawBody).toString("base64")]),
    event,
  );
  return { status, eventId: event.eventId };
}
