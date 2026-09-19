CREATE TABLE IF NOT EXISTS molecule_shopify_orders (
  namespace text NOT NULL,
  order_id text NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, order_id)
);

CREATE TABLE IF NOT EXISTS molecule_shopify_events (
  sequence bigserial PRIMARY KEY,
  namespace text NOT NULL,
  event_id uuid NOT NULL,
  order_id text,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, event_id)
);
CREATE INDEX IF NOT EXISTS molecule_shopify_events_order_idx
  ON molecule_shopify_events(namespace, order_id, sequence);

CREATE TABLE IF NOT EXISTS molecule_shopify_webhooks (
  namespace text NOT NULL,
  domain text NOT NULL,
  delivery_id text NOT NULL,
  body_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, domain, delivery_id)
);
