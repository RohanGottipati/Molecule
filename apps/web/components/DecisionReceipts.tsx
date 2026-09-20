import type {
  MarketplaceSnapshot,
  OrderSessionSnapshot,
} from "@molecule/contracts";
import { humanize, supplierAdminUrl } from "../lib/workspace";
import { Badge, DecisionLink } from "./DecisionPrimitives";

export function DecisionReceipts({
  order,
  marketplace,
}: {
  order: OrderSessionSnapshot;
  marketplace: MarketplaceSnapshot | null;
}) {
  const receipt = order.executionReceipt;
  if (!receipt) return null;
  const previous =
    receipt.planId !== order.activePlan?.planId ||
    receipt.intentVersion !== order.intentVersion;
  const pending = receipt.actions.filter(
    (action) => action.status === "PENDING",
  ).length;
  const failed = receipt.actions.filter(
    (action) => action.status === "FAILED",
  ).length;
  return (
    <section
      className="receipt decision-receipts"
      aria-label={previous ? "Previous plan receipt" : "Current plan receipt"}
    >
      <div className="receipt-heading">
        <h3>
          {previous ? "Previous" : "Current"} plan receipt · version{" "}
          {receipt.intentVersion}
        </h3>
        <code>{receipt.planId}</code>
      </div>
      {previous && (
        <p className="inline-warning">
          This receipt does not confirm the current plan. Original action
          statuses and links are historical; check provider records for
          supersession outcomes before using a previously shared invoice.
        </p>
      )}
      <p className="decision-receipt-counts">
        {
          receipt.actions.filter((action) => action.status === "SUCCEEDED")
            .length
        }{" "}
        actions succeeded · {pending} pending · {failed} failed ·{" "}
        {
          receipt.actions.filter((action) => action.status === "COMPENSATED")
            .length
        }{" "}
        compensated
      </p>
      {(pending > 0 || failed > 0) && (
        <p className="inline-warning">
          Execution is incomplete. Pending means the outcome is not confirmed;
          failed actions require review. Successful actions may already have
          changed provider records.
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Commerce action</th>
              <th>Recorded outcome</th>
              <th>Provider evidence</th>
            </tr>
          </thead>
          <tbody>
            {receipt.actions.map((action) => (
              <tr key={action.actionKey}>
                <td>
                  <strong>{humanize(action.kind)}</strong>
                </td>
                <td>
                  <Badge value={action.status} />
                  {action.errorCode && <small>{action.errorCode}</small>}
                </td>
                <td>
                  <details>
                    <summary>Action &amp; provider references</summary>
                    <dl className="decision-identities">
                      <div>
                        <dt>Action key</dt>
                        <dd>
                          <code>{action.actionKey}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Provider reference</dt>
                        <dd>
                          <code>{action.providerRef ?? "Not returned"}</code>
                        </dd>
                      </div>
                    </dl>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!receipt.actions.length && (
        <p className="muted">
          No action receipts returned. This does not establish execution
          success.
        </p>
      )}
      <details className="decision-provider-records">
        <summary>
          {previous
            ? "Historical provider links & supplier jobs"
            : "Provider links & supplier jobs"}{" "}
          ({receipt.supplierJobs.length})
        </summary>
        <div className="receipt-links">
          <DecisionLink href={receipt.compositeProduct?.adminUrl}>
            Product admin
          </DecisionLink>
          <DecisionLink href={receipt.compositeProduct?.storefrontUrl}>
            Storefront
          </DecisionLink>
          <DecisionLink href={receipt.customerOrder?.checkoutUrl}>
            {previous ? "Previous customer checkout" : "Customer checkout"}
          </DecisionLink>
        </div>
        <dl className="decision-identities">
          <div>
            <dt>Product</dt>
            <dd>
              <code>
                {receipt.compositeProduct?.productGid ?? "Not returned"}
              </code>
            </dd>
          </div>
          <div>
            <dt>Variant</dt>
            <dd>
              <code>
                {receipt.compositeProduct?.variantGid ?? "Not returned"}
              </code>
            </dd>
          </div>
          <div>
            <dt>Customer order</dt>
            <dd>
              <code>
                {receipt.customerOrder?.orderGid ??
                  receipt.customerOrder?.draftOrderGid ??
                  "Not returned"}
              </code>
            </dd>
          </div>
        </dl>
        <ul className="document-list">
          {receipt.supplierJobs.map((job) => (
            <li key={`${job.nodeId}:${job.draftOrderGid}`}>
              <span>
                <strong>
                  {marketplace?.merchants.find(
                    (merchant) => merchant.merchantId === job.merchantId,
                  )?.name ?? job.merchantId}
                </strong>
                <small>
                  Node: {job.nodeId} · {job.storeDomain}
                </small>
                <small>{job.draftOrderGid}</small>
              </span>
              <DecisionLink
                href={supplierAdminUrl(job.storeDomain, job.draftOrderGid)}
              >
                Supplier admin
              </DecisionLink>
            </li>
          ))}
        </ul>
        {!receipt.supplierJobs.length && (
          <p className="muted">No supplier job records returned.</p>
        )}
      </details>
      <p className="muted small">
        Provider action status describes commerce records. Compensation or
        supersession does not establish that physical work stopped or that a
        shared invoice was revoked.
      </p>
    </section>
  );
}
