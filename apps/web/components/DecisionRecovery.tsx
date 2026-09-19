"use client";

import type {
  MarketplaceSnapshot,
  OrderSessionSnapshot,
} from "@molecule/contracts";
import { useState } from "react";

export function DecisionRecovery({
  order,
  marketplace,
  busy,
  demoMode,
  onOffline,
}: {
  order: OrderSessionSnapshot | null;
  marketplace: MarketplaceSnapshot | null;
  busy: boolean;
  demoMode: boolean;
  onOffline: (merchantId: string) => void;
}) {
  const [confirming, setConfirming] = useState<{
    planId: string;
    merchantId: string;
  } | null>(null);
  const plan = order?.activePlan;
  const selected = [
    ...new Set(plan?.nodes.map((node) => node.merchantId) ?? []),
  ];
  const allowed =
    demoMode &&
    !busy &&
    plan?.status === "VALID" &&
    plan.intentVersion === order?.intentVersion &&
    ["AWAITING_APPROVAL", "COMPLETED"].includes(order?.state ?? "");
  return (
    <section className="panel decision-recovery">
      <div className="section-heading">
        <div>
          <p className="eyebrow">DEMO RECOVERY</p>
          <h2>Replace an unavailable supplier</h2>
        </div>
        <span className="mode-tag">
          {demoMode ? "Demo enabled by server" : "Demo controls unavailable"}
        </span>
      </div>
      <div className="inset">
        <p>
          Mark a selected supplier offline to exclude it, request new quotes and
          run the solver again.
        </p>
        <p className="decision-recovery-policy">
          For a previously completed plan, the server may execute a validated
          replacement automatically within the existing budget and deadline. If
          there is no budget ceiling, a cost increase requires approval. Plans
          that were not approved require approval before execution.
        </p>
        <p className="muted">
          Existing supplier jobs may be superseded and reservations released
          before a feasible replacement is found. This does not undo physical
          work or revoke an externally shared invoice.
        </p>
        {demoMode && selected.length && plan ? (
          <ul className="decision-recovery-list">
            {selected.map((id) => {
              const merchant = marketplace?.merchants.find(
                (item) => item.merchantId === id,
              );
              const name = merchant?.name ?? id;
              const confirmingThis =
                confirming?.planId === plan.planId &&
                confirming.merchantId === id;
              return (
                <li key={id}>
                  <div className="decision-recovery-choice">
                    <strong>{name}</strong>
                    <button
                      className="danger-outline"
                      type="button"
                      disabled={!allowed || merchant?.status === "offline"}
                      onClick={() =>
                        setConfirming({ planId: plan.planId, merchantId: id })
                      }
                    >
                      {merchant?.status === "offline"
                        ? "Already offline"
                        : `Take ${name} offline`}
                    </button>
                  </div>
                  {confirmingThis && (
                    <div className="decision-confirmation">
                      <p>
                        Take {name} offline for plan <code>{plan.planId}</code>?{" "}
                        {order?.state === "COMPLETED"
                          ? "Existing commitments will be affected and an eligible replacement may execute without another approval."
                          : "The current plan will be invalidated. Review and approve any validated replacement."}
                      </p>
                      <div>
                        <button
                          className="danger-outline"
                          type="button"
                          disabled={!allowed || merchant?.status === "offline"}
                          onClick={() => {
                            setConfirming(null);
                            onOffline(id);
                          }}
                        >
                          Confirm offline &amp; find replacement
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => setConfirming(null)}
                        >
                          Keep supplier
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">
            {demoMode
              ? "A selected production plan is required."
              : "The server must enable demo mode to use supplier-offline controls."}
          </p>
        )}
        <details>
          <summary>Available recovery controls</summary>
          <p className="muted">
            Inventory, price, lead-time and conflicting-document simulations are
            not enabled by this server contract.
          </p>
        </details>
      </div>
    </section>
  );
}
