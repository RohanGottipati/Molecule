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
    <section className="company" aria-label="Production plan">
      <div className="section-title">
        <div>
          <p className="eyebrow">PRODUCTION NETWORK</p>
          <h2>Your temporary company</h2>
        </div>
        <span
          className={`plan-status ${plan?.status === "VALID" ? "success" : ""}`}
        >
          {plan?.status ?? "No plan yet"}
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
          <div className="customer">
            <span className="node-mark" aria-hidden="true">
              M
            </span>
            <span>
              Your request{" "}
              <small>
                {plan.nodes.length} steps · {plan.edges.length} connections
              </small>
            </span>
          </div>
          {planLayers(plan).map((layer, index) => (
            <section
              className="graph-stage"
              aria-label={`Stage ${index + 1}`}
              key={index}
            >
              <h3 className="stage-title">
                Stage {String(index + 1).padStart(2, "0")}
                <span>
                  {layer.length > 1
                    ? `${layer.length} parallel steps`
                    : "1 step"}
                </span>
              </h3>
              <div className="graph-layer">
                {layer.map((node) => {
                  const candidate = project.candidates.find(
                    (item) => item.capabilityId === node.capabilityId,
                  );
                  const incoming = plan.edges.filter(
                    (edge) => edge.toNodeId === node.nodeId,
                  );
                  return (
                    <div className="graph-node" key={node.nodeId}>
                      <details
                        className={`merchant-detail ${failedMerchants.includes(node.merchantId) ? "failed" : ""}`}
                      >
                        <summary className="merchant">
                          <span className="node-mark" aria-hidden="true">
                            {node.kind.slice(0, 1)}
                          </span>
                          <div>
                            <b>{candidate?.capability.name ?? node.kind}</b>
                            <small>{node.merchantId}</small>
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
                        </summary>
                        <div className="node-details">
                          <dl>
                            <div>
                              <dt>Step</dt>
                              <dd>{node.kind}</dd>
                            </div>
                            <div>
                              <dt>Quantity</dt>
                              <dd>{node.quantity}</dd>
                            </div>
                            <div>
                              <dt>Risk confidence</dt>
                              <dd>
                                {candidate?.risk?.confidence ?? "Unknown"}
                              </dd>
                            </div>
                          </dl>
                          <p className="dependency-label">Receives from</p>
                          {incoming.length ? (
                            <ul>
                              {incoming.map((edge) => (
                                <li key={edge.edgeId}>
                                  {plan.nodes.find(
                                    (item) => item.nodeId === edge.fromNodeId,
                                  )?.merchantId ?? edge.fromNodeId}
                                  <small>
                                    {edge.quantity} {edge.unit} ·{" "}
                                    {edge.material}
                                  </small>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p>Your request</p>
                          )}
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="candidate-list">
          {!project.candidates.length && (
            <p className="empty-state">
              {["CANCELLED", "COMPLETED", "NEEDS_HUMAN"].includes(project.state)
                ? "No production steps are available for this project."
                : "Your production network will appear here as Molecule finds suppliers and evaluates their quotes."}
            </p>
          )}
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
          <dt>Estimated completion</dt>
          <dd>
            {plan?.estimatedCompletion
              ? new Date(plan.estimatedCompletion).toLocaleDateString()
              : "Not confirmed"}
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
