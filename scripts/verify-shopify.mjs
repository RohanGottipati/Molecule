// Verifies every connected Shopify dev store: gets a token via the client credentials grant,
// reads the shop name, and lists the granted scopes. Never prints secrets or tokens.
// Usage: node --env-file=.env scripts/verify-shopify.mjs
const { SHOPIFY_CLIENT_ID, SHOPIFY_API_SECRET, SHOPIFY_STORES, SHOPIFY_API_VERSION = "2026-07" } = process.env;

if (!SHOPIFY_CLIENT_ID || !SHOPIFY_API_SECRET || !SHOPIFY_STORES) {
  console.error("Missing SHOPIFY_CLIENT_ID, SHOPIFY_API_SECRET or SHOPIFY_STORES in .env");
  process.exit(1);
}

async function getToken(shop) {
  const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_API_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`token request ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

async function gql(shop, token, query) {
  const r = await fetch(`https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

let failed = 0;
for (const shop of SHOPIFY_STORES.split(",").map((s) => s.trim()).filter(Boolean)) {
  try {
    const token = await getToken(shop);
    const d = await gql(shop, token, "{ shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }");
    const scopes = d.currentAppInstallation.accessScopes.map((s) => s.handle).join(", ");
    console.log(`OK   ${d.shop.myshopifyDomain}  "${d.shop.name}"  scopes: ${scopes}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${shop}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
