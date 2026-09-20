# Broad catalog handoff in Tiger

> Status reconciled 2026-09-19: [current database/ROX assessment](DATABASE_ROX.md) is the
> source for current counts, evaluation caveats and priorities. Historical test
> results and incidents below apply only to their recorded revision/environment.

Migration `017_broad_catalog_handoff.sql` creates an additive staging area so the
data and integration workstreams can inspect the same starting point. It does not
alter existing merchants, capabilities, canonical claims or Shopify catalog rows.

- `catalog_categories`: the 12 category labels supplied in the plan, with eight
  target recipes each. The other 20 labels have not been supplied yet.
- `catalog_import_batches`: batch `broad-network-v1` records the agreed release
  targets and planned stores. It starts at `awaiting_delivery`.
- `catalog_import_records`: raw merchant, product, variant, capability, resource,
  fact, binding and relationship envelopes. Each requires a stable local ID,
  source reference, observation time, synthetic marker, trace ID and action key.
- `catalog_handoff_coverage`: registered categories and staged record counts.

The staging envelope is deliberately **draft**, pending the shared manifest
contract in `@molecule/contracts`. JSON payloads here are untrusted source data,
not canonical domain objects. Unknown or conflicted operational facts must remain
explicit; no stock, prices, capacity, working calendars or durations are inferred.
Existing `shopify_products`, `shopify_variants`, `capabilities` and canonical claim
tables remain the downstream integration targets. No products have been imported
or certified by this migration, and no new Shopify stores have been provisioned.

Teammate agents connected to the same Tiger database can discover the schema and
query it immediately after migration commit:

```sql
select * from catalog_handoff_coverage order by label;
select * from catalog_import_batches where batch_id = 'broad-network-v1';
select event_id, trace_id, event_type, ts, payload
from molecule_events where event_type = 'catalog.handoff.prepared';
```

The persisted `catalog.handoff.prepared` event records the bootstrap. It does not
send a message to another agent or establish an event subscription. Agents need
to query the shared database or their existing event consumer.

For delivery, use a new batch/action key for each immutable revision. Repeating a
record's `(batch_id, record_kind, local_id)` or action key is rejected by database
uniqueness; an importer must compare payloads before treating a retry as identical.
Importers must persist a `MoleculeEvent` transactionally with meaningful changes.
Only validated data may later be promoted through claim resolution and catalog
bindings. A staging status never establishes executable readiness.

Subsequent work added canonical manifest validation, an immutable-version importer
and local solver integration. See [delivery review](CATALOG_DELIVERY_REVIEW.md).
Actual teammate delivery and shared deployment require separate verification.

## Verification and deployment status

On 2026-09-19, all 27 database unit/integration checks passed against an isolated
local PostgreSQL database, including the 12 catalog handoff checks. The current
migration runner handles the older bulk migration's optional TimescaleDB calls,
so the full database suite now runs locally. Database lint/typecheck and handoff
formatting checks passed.

At that verification checkpoint, shared Tiger deployment was **pending**. Both attempts rolled back on a lock
timeout: an existing idle transaction (PID 94431 at the time of inspection) holds
advisory lock `73481203`, also required by the existing event-cursor trigger.
No new tables or category rows were committed. The owner of that transaction must
commit or roll it back before retrying; do not disable the event trigger or
terminate another workstream's database session to bypass it.

The offline [delivery-review command](CATALOG_DELIVERY_REVIEW.md) is available
while that transaction completes. Synthetic 20-recipe and 100-recipe intake
reports are in `.molecule-data/catalog-delivery-review/`; they are not evidence
that the teammate's delivery has been received or that live execution passed.
