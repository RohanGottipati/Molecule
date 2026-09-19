"use client";

import type { MoleculeEvent, OrderSessionSnapshot } from "@molecule/contracts";
import { useCallback, useEffect, useState } from "react";

import {
  API_URL,
  approvePlan,
  createOrder,
  getOrder,
  submitMessage,
  triggerSupplierOffline,
} from "../lib/api";
import { PlanGraph } from "./PlanGraph";
import { VoiceControl } from "./VoiceControl";

const sample =
  "Make 50 black hoodies with embroidery by 2026-10-15 under $3,000 CAD, no polyester";

export function OrderWorkspace({
  initialOrderId,
}: {
  initialOrderId?: string;
}) {
  const [order, setOrder] = useState<OrderSessionSnapshot | null>(null);
  const [events, setEvents] = useState<MoleculeEvent[]>([]);
  const [text, setText] = useState(sample);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setEvents([]);
      setOrder(await createOrder());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create order",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!initialOrderId) {
      void reset();
      return;
    }
    let cancelled = false;
    setBusy(true);
    void getOrder(initialOrderId)
      .then((snapshot) => {
        if (!cancelled) setOrder(snapshot);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this project");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialOrderId, reset]);
  useEffect(() => {
    if (!order?.orderId) return;
    const source = new EventSource(
      `${API_URL}/api/orders/${order.orderId}/events`,
    );
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void getOrder(order.orderId)
          .then((snapshot) => {
            if (cancelled) return;
            setOrder((current) =>
              current &&
              current.orderId === snapshot.orderId &&
              current.revision <= snapshot.revision
                ? snapshot
                : current,
            );
            setError(null);
          })
          .catch(() => {
            if (!cancelled) setError("Could not refresh project");
          });
      }, 100);
    };
    source.addEventListener("ready", refresh);
    source.addEventListener("molecule", (message) => {
      const event = JSON.parse(
        (message as MessageEvent<string>).data,
      ) as MoleculeEvent;
      setEvents((current) => [...current.slice(-39), event]);
      refresh();
    });
    source.onerror = () => setError("Event stream reconnecting…");
    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
      source.close();
    };
  }, [order?.orderId]);

  async function act(action: () => Promise<OrderSessionSnapshot>) {
    setBusy(true);
    setError(null);
    try {
      setOrder(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const plan = order?.activePlan;
  return (
    <main>
      <header>
        <div className="brand">
          <span>M</span> molecule <em>OS</em>
        </div>
        <div className="status">
          <i /> {order?.state ?? "CONNECTING"}
        </div>
        <button className="ghost" type="button" onClick={() => void reset()}>
          New order
        </button>
      </header>

      <section className="hero">
        <p className="eyebrow">PRODUCTION INTELLIGENCE / 01</p>
        <h1>
          Describe the outcome.
          <br />
          <span>We&apos;ll assemble the path.</span>
        </h1>
        <p className="lede">
          One constraint-aware workspace for sourcing, transformation, assembly,
          and fulfillment.
        </p>
      </section>

      <section className="composer">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="Production request"
        />
        <div className="composer-actions">
          {order && <VoiceControl orderId={order.orderId} />}
          <button
            className="primary"
            type="button"
            disabled={busy || !order || text.trim().length === 0}
            onClick={() =>
              order && void act(() => submitMessage(order.orderId, text))
            }
          >
            {busy ? "Working…" : "Build production plan →"}
          </button>
        </div>
      </section>
      {error && <p className="error">{error}</p>}

      <section className="workspace">
        <article className="panel intent-panel">
          <div className="panel-title">
            <span>01</span>
            <h2>Compiled intent</h2>
          </div>
          {order?.intent ? (
            <dl>
              <div>
                <dt>Quantity</dt>
                <dd>{order.intent.quantity ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>{order.intent.deadline?.slice(0, 10) ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>
                  {order.intent.budgetMax
                    ? `${order.intent.currency} ${order.intent.budgetMax}`
                    : "Open"}
                </dd>
              </div>
              <div>
                <dt>Outputs</dt>
                <dd>
                  {order.intent.desiredOutputs
                    .map((item) => item.name)
                    .join(", ") || "Unknown"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="empty">
              Your structured requirements will appear here.
            </p>
          )}
          {order?.intent?.ambiguityFlags.map((flag) => (
            <p className="question" key={flag.field}>
              {flag.question ?? flag.reason}
            </p>
          ))}
        </article>

        <article className="panel plan-panel">
          <div className="panel-title">
            <span>02</span>
            <h2>Certified plan</h2>
            {plan && <b className={plan.status.toLowerCase()}>{plan.status}</b>}
          </div>
          {plan?.status === "VALID" ? (
            <PlanGraph plan={plan} />
          ) : (
            <p className="empty">
              The deterministic solver will render a feasible production graph.
            </p>
          )}
          {plan && (
            <div className="plan-summary">
              <span>
                Total{" "}
                <strong>
                  {plan.currency} {plan.totalCost.toFixed(2)}
                </strong>
              </span>
              <span>
                Risk <strong>{Math.round(plan.riskScore * 100)}%</strong>
              </span>
              <span>
                Completion{" "}
                <strong>{plan.estimatedCompletion?.slice(0, 10) ?? "—"}</strong>
              </span>
            </div>
          )}
          {order?.state === "AWAITING_APPROVAL" && plan?.status === "VALID" && (
            <button
              className="primary approve"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  approvePlan(order.orderId, plan.planId, order.intentVersion),
                )
              }
            >
              Approve &amp; create order
            </button>
          )}
        </article>

        <aside className="panel event-panel">
          <div className="panel-title">
            <span>03</span>
            <h2>Decision log</h2>
          </div>
          <ol>
            {events.length === 0 && (
              <li className="empty">Waiting for events…</li>
            )}
            {[...events].reverse().map((event) => (
              <li key={event.eventId}>
                <time>{new Date(event.ts).toLocaleTimeString()}</time>
                <b>{event.eventType}</b>
                <small>{event.source}</small>
              </li>
            ))}
          </ol>
        </aside>
      </section>

      {process.env.NEXT_PUBLIC_DEMO_MODE === "true" &&
        plan?.nodes[0] &&
        order && (
          <button
            className="chaos"
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() =>
                triggerSupplierOffline(
                  order.orderId,
                  plan.nodes[0]!.merchantId,
                ),
              )
            }
          >
            Simulate supplier offline
          </button>
        )}
    </main>
  );
}
