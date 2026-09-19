import type { DesktopState, DesktopStore } from "../state/desktop-store.js";
import type { VoiceSnapshot } from "../services/realtime-client.js";
import { TemporaryCompany } from "./TemporaryCompany.js";

export interface TextTurn {
  id: string;
  text: string;
}

export function DockConversation({
  store,
  state,
  audio,
  turns,
  onNew,
  onCancel,
}: {
  store: DesktopStore;
  state: DesktopState;
  audio: VoiceSnapshot;
  turns: TextTurn[];
  onNew: () => void;
  onCancel: () => void;
}) {
  const project = state.project;
  const capabilities = store.getCapabilities();
  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => store.error(error));
  };
  return (
    <>
      {!project && !turns.length && !audio.transcript && (
        <div className="welcome">
          <span className="eyebrow">YOUR COMPANY, ON DEMAND</span>
          <h1>From idea to made.</h1>
          <p>
            Tell Molecule the outcome. Bring a reference, set your constraints,
            and build a plan together.
          </p>
          {state.bootstrap?.settings.lastProjectId && (
            <button
              onClick={() =>
                run(store.openProject(state.bootstrap!.settings.lastProjectId!))
              }
            >
              Resume previous project
            </button>
          )}
        </div>
      )}
      <div
        className="conversation-turns"
        role="region"
        aria-label="Recent conversation"
      >
        {turns.map((turn) => (
          <div key={turn.id} className="transcript">
            <span>YOU</span>
            <p>{turn.text}</p>
          </div>
        ))}
        {audio.history.map((turn) => (
          <div
            key={turn.id}
            className={`transcript ${turn.speaker === "Molecule" ? "assistant" : ""}`}
          >
            <span>{turn.speaker}</span>
            <p>{turn.text}</p>
          </div>
        ))}
        {audio.transcript && (
          <div className="transcript">
            <span>YOU · VOICE</span>
            <p>{audio.transcript}</p>
          </div>
        )}
        {audio.response && (
          <div className="transcript assistant">
            <span>MOLECULE</span>
            <p>{audio.response}</p>
          </div>
        )}
      </div>
      {project?.intent?.ambiguityFlags.map((flag, index) => (
        <p className="question" key={`${index}:${flag.field}`}>
          {flag.question ?? flag.reason}
        </p>
      ))}
      {!!state.attachments.length && (
        <details className="attached-context">
          <summary>Project context · {state.attachments.length}</summary>
          <div className="attachments">
            {state.attachments.map((asset) => (
              <span key={asset.assetId} title={asset.name ?? asset.assetId}>
                {asset.name ?? asset.assetId}
                <small>Attached</small>
              </span>
            ))}
          </div>
        </details>
      )}
      {state.recovery && (
        <div className="recovery-summary">
          {state.recovery.deadlinePreserved === true && (
            <span>Deadline preserved</span>
          )}
          {typeof state.recovery.costDelta === "number" && (
            <span>
              {state.recovery.costDelta > 0 ? "+" : ""}
              {String(state.recovery.currency ?? "")}{" "}
              {state.recovery.costDelta.toFixed(2)}
            </span>
          )}
          {state.recovery.approvalRequired === false && (
            <span>No action required</span>
          )}
        </div>
      )}
      {project && (
        <>
          <div className="project-tabs">
            <button
              aria-pressed={state.mode === "company"}
              onClick={() =>
                run(
                  store.mode(
                    state.mode === "company" ? "conversation" : "company",
                  ),
                )
              }
            >
              {state.mode === "company" ? "Hide company" : "Show company"}
            </button>
            <button onClick={onNew}>New project</button>
            <button
              disabled={[
                "CANCELLED",
                "COMPLETED",
                "EXECUTING",
                "SKU_CREATED",
                "SUPPLIER_JOBS_CREATED",
                "CUSTOMER_ORDER_CREATED",
              ].includes(project.state)}
              onClick={onCancel}
            >
              Cancel project
            </button>
          </div>
          {(state.mode === "company" || state.mode === "alert") && (
            <TemporaryCompany
              project={project}
              failedMerchants={state.failedMerchants}
            />
          )}
          {!!project.intent?.hardConstraints.length && (
            <details>
              <summary>
                Hard requirements ({project.intent.hardConstraints.length})
              </summary>
              {project.intent.hardConstraints.map((constraint) => (
                <div className="constraint" key={constraint.constraintId}>
                  <span>
                    {constraint.description ??
                      `${constraint.field} ${constraint.operator} ${String(constraint.value)}`}
                  </span>
                  <button
                    disabled={state.pending > 0}
                    aria-label={`Remove requirement ${constraint.field}`}
                    onClick={() =>
                      run(
                        store.command({
                          name: "remove_constraint",
                          args: { constraintId: constraint.constraintId },
                        }),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </details>
          )}
          {project.state === "AWAITING_APPROVAL" &&
            project.activePlan?.status === "VALID" && (
              <button
                className="primary approve"
                disabled={state.pending > 0 || !capabilities.canApprove}
                title={capabilities.approvalBlockedReason ?? undefined}
                onClick={() =>
                  run(
                    store.command({
                      name: "approve_action",
                      args: {
                        planId: project.activePlan!.planId,
                        intentVersion: project.intentVersion,
                      },
                    }),
                  )
                }
              >
                Approve {project.activePlan.currency}{" "}
                {project.activePlan.totalCost.toFixed(2)} &amp; execute
              </button>
            )}
          {project.state === "AWAITING_APPROVAL" &&
            capabilities.approvalBlockedReason && (
              <p className="question" role="status">
                {capabilities.approvalBlockedReason}
              </p>
            )}
          <details className="activity-section" open>
            <summary>Activity</summary>
            <ol className="activity">
              {[...state.activity]
                .reverse()
                .slice(0, 7)
                .map((item) => (
                  <li key={item.id} className={item.severity}>
                    <span>
                      {item.label}
                      {item.merchantId && <small>{item.merchantId}</small>}
                    </span>
                    <time dateTime={item.timestamp}>
                      {new Date(item.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </li>
                ))}
            </ol>
          </details>
        </>
      )}
      <details className="provider-status">
        <summary>
          {state.marketplace
            ? `${state.marketplace.mode} providers`
            : "Provider availability"}
        </summary>
        {state.marketplace?.providers.map((provider) => (
          <p key={provider.name}>
            <strong>{provider.name}</strong> · {provider.mode} ·{" "}
            {provider.status}
            <small>{provider.detail}</small>
          </p>
        ))}
        {state.providerError && <p role="status">{state.providerError}</p>}
        {state.marketplace && (
          <small>
            Checked{" "}
            {new Date(state.marketplace.generatedAt).toLocaleTimeString()}
          </small>
        )}
        <button onClick={() => run(store.refreshProviders())}>
          Refresh availability
        </button>
      </details>
      {!state.marketplace && state.mockProviders.length > 0 && (
        <p className="demo-note">
          Development providers: {state.mockProviders.join(", ")} are mocked.
        </p>
      )}
      {state.demoMode && project?.activePlan?.status === "VALID" && (
        <details className="developer">
          <summary>Demo controls</summary>
          <button
            disabled={state.pending > 0}
            onClick={() => run(store.chaos())}
          >
            Take embroidery supplier offline
          </button>
        </details>
      )}
    </>
  );
}
