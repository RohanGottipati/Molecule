import type { OrderSessionSnapshot } from "@molecule/contracts";
import { planLayers } from "./graph-layout.js";

export function TemporaryCompany({
  project,
  failedMerchants,
}: {
  project: OrderSessionSnapshot;
  failedMerchants: string[];
}) {
  const plan = project.activePlan;
  return (
    <section className="company">
      <div className="section-title">
        <h2>Your temporary company</h2>
        <span className={plan?.status === "VALID" ? "success" : ""}>
          {plan?.status ?? "Building"}
        </span>
      </div>
      {failedMerchants.map((id) => (
        <div className="merchant failed" key={id}>
          <span className="node-mark">!</span>
          <div>
            <b>{id}</b>
            <small>Offline · excluded from replanning</small>
          </div>
          <span>Failed</span>
        </div>
      ))}
      {plan?.nodes.length ? (
        <div
          className="production-graph"
          aria-label="Selected production graph"
        >
          <div className="customer">Your request</div>
          {planLayers(plan).map((layer, index) => (
            <div className="graph-layer" key={index}>
              {layer.map((node) => {
                const candidate = project.candidates.find(
                  (item) => item.capabilityId === node.capabilityId,
                );
                const incoming = plan.edges.filter(
                  (edge) => edge.toNodeId === node.nodeId,
                );
                return (
                  <div className="graph-node" key={node.nodeId}>
                    <div
                      className="graph-edge"
                      aria-label={
                        incoming.length
                          ? `From ${incoming.map((edge) => plan.nodes.find((item) => item.nodeId === edge.fromNodeId)?.merchantId ?? edge.fromNodeId).join(", ")}`
                          : "From customer"
                      }
                    >
                      ↓
                    </div>
                    <div
                      className={`merchant ${failedMerchants.includes(node.merchantId) ? "failed" : "selected"}`}
                    >
                      <span className="node-mark">{node.kind.slice(0, 1)}</span>
                      <div>
                        <b>{node.merchantId}</b>
                        <small>
                          {candidate?.capability.name ?? node.kind} ·{" "}
                          {candidate?.risk?.confidence ?? "unknown"} confidence
                        </small>
                      </div>
                      <div className="node-metric">
                        <span>
                          {failedMerchants.includes(node.merchantId)
                            ? "Failed"
                            : plan.status === "VALID"
                              ? "Selected"
                              : plan.status}
                        </span>
                        <small>
                          {plan.currency} {node.totalCost.toFixed(2)}
                        </small>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="candidate-list">
          {project.candidates.slice(0, 6).map((candidate) => {
            const quote = project.quotes.find(
              (item) => item.capabilityId === candidate.capabilityId,
            );
            return (
              <div className="candidate" key={candidate.capabilityId}>
                <span>{candidate.merchantId}</span>
                <small>
                  {quote
                    ? quote.status === "CAN_ACCEPT"
                      ? "Quote accepted"
                      : quote.status === "DECLINE"
                        ? "Declined"
                        : "Counteroffer"
                    : project.state === "QUOTING"
                      ? "Contacting"
                      : "Candidate"}
                </small>
              </div>
            );
          })}
        </div>
      )}
      <dl className="plan-summary">
        <div>
          <dt>Plan cost / budget</dt>
          <dd>
            {plan ? `${plan.currency} ${plan.totalCost.toFixed(2)}` : "Pending"}{" "}
            / {project.intent?.budgetMax ?? "Open"}
          </dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>
            {project.intent?.deadline
              ? new Date(project.intent.deadline).toLocaleDateString()
              : "Not set"}
          </dd>
        </div>
      </dl>
      {plan?.status === "UNSAT" && (
        <div className="error">
          <strong>
            No valid company can satisfy all current requirements.
          </strong>
          {plan.constraintResults
            .filter((result) => !result.satisfied)
            .map((result) => (
              <p key={result.constraintId}>{result.explanation}</p>
            ))}
          {plan.unsatRelaxations.map((result) => (
            <p key={result.constraintId}>{result.explanation}</p>
          ))}
        </div>
      )}
    </section>
  );
}
