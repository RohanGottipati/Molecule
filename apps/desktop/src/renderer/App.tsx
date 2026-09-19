import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScreenSource } from "../shared/bridge.js";
import { DesktopStore } from "./state/desktop-store.js";
import { useVoice } from "./useVoice.js";
import { TemporaryCompany } from "./components/TemporaryCompany.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { captureFrame } from "./services/screen-context.js";

export function App() {
  const [store] = useState(() => new DesktopStore(window.moleculeDesktop));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [text, setText] = useState("");
  const [lastText, setLastText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [listingSources, setListingSources] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  const sourceSelect = useRef<HTMLSelectElement>(null);
  const sourceTitle = useRef<HTMLHeadingElement>(null);
  const orb = useRef<HTMLButtonElement>(null);
  const screenRequest = useRef(0);
  const { voice, state: audio, toggle: toggleVoice } = useVoice(store);
  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => store.error(error));
  };
  useEffect(() => {
    void store.initialize().then(() => store.refreshProviders());
    const providersTimer = setInterval(() => {
      void store.refreshProviders();
    }, 60_000);
    const unsubscribe = store.bridge.onSignal((signal) => {
      if (signal.type === "visibility") store.setVisible(signal.visible);
      if (signal.type === "project") run(store.openProject(signal.projectId));
      if (
        (signal.type === "visibility" && !signal.visible) ||
        signal.type === "project"
      ) {
        screenRequest.current += 1;
        setSources(null);
        setListingSources(false);
      }
      if (signal.type === "settings") {
        screenRequest.current += 1;
        setSources(null);
        setListingSources(false);
        setShowSettings(true);
        run(store.mode("conversation"));
      }
      if (signal.type === "start-voice") setShowSettings(false);
    });
    return () => {
      unsubscribe();
      clearInterval(providersTimer);
      store.dispose();
    };
  }, [store]);
  useEffect(() => {
    if (state.mode === "compact") orb.current?.focus();
    else if (!showSettings) input.current?.focus();
  }, [state.mode, showSettings]);
  useEffect(() => {
    if (sources) (sourceSelect.current ?? sourceTitle.current)?.focus();
  }, [sources]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (sources || listingSources) {
        screenRequest.current += 1;
        setSources(null);
        setListingSources(false);
        shareButton.current?.focus();
      } else if (showSettings) {
        setShowSettings(false);
        requestAnimationFrame(() => settingsButton.current?.focus());
      } else {
        run(store.bridge.hideOverlay());
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [store, showSettings, sources, listingSources]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const voiceActive = !["idle", "error"].includes(audio.state);
  const project = state.project;
  return (
    <main
      className={`overlay ${dragging ? "dragging" : ""}`}
      data-mode={state.mode}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
        if (state.mode === "compact") run(store.mode("conversation"));
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        run(store.upload(Array.from(event.dataTransfer.files)));
      }}
      onPaste={(event) => {
        if (
          (event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLSelectElement) &&
          showSettings
        )
          return;
        event.preventDefault();
        const files = Array.from(event.clipboardData.files);
        const plain = event.clipboardData.getData("text/plain");
        const start = input.current?.selectionStart ?? text.length;
        const end = input.current?.selectionEnd ?? text.length;
        run(
          (async () => {
            if (files.length) return store.upload(files);
            let pasted = false;
            await store.uploadFrom(async () => {
              const captured = await store.bridge.pasteFiles();
              pasted = captured.length > 0;
              return captured.map(
                (file) =>
                  new File([new Uint8Array(file.bytes)], file.name, {
                    type: file.mimeType,
                  }),
              );
            });
            if (pasted) return;
            setText(
              (current) => current.slice(0, start) + plain + current.slice(end),
            );
            await store.mode("conversation");
            input.current?.focus();
          })(),
        );
      }}
    >
      <header className="drag-region">
        <button
          ref={orb}
          className="orb"
          aria-label={
            state.mode === "compact" ? "Expand Molecule" : "Collapse Molecule"
          }
          aria-expanded={state.mode !== "compact"}
          onClick={() =>
            run(
              store.mode(state.mode === "compact" ? "conversation" : "compact"),
            )
          }
        >
          M
        </button>
        <div className="brand">
          <strong>
            Molecule <span>OS</span>
          </strong>
          <small role="status">
            {voiceActive
              ? audio.muted
                ? "Microphone muted"
                : audio.state
              : state.connection === "connected"
                ? "Ready when you are"
                : `Backend ${state.connection}`}
          </small>
        </div>
        <button
          className={`mic-button ${voiceActive ? "active" : ""}`}
          aria-label={voiceActive ? "Stop voice" : "Start voice"}
          aria-pressed={voiceActive}
          onClick={() => {
            if (!voiceActive) setShowSettings(false);
            run(toggleVoice());
          }}
        >
          {voiceActive ? "Stop" : "Talk"}
        </button>
        <span
          className={`connection ${state.connection}`}
          aria-label={`Backend ${state.connection}`}
        />
        <button
          aria-label="Hide Molecule"
          onClick={() => run(store.bridge.hideOverlay())}
        >
          ×
        </button>
      </header>
      {state.mode !== "compact" && (
        <div className="content">
          {showSettings && state.bootstrap ? (
            <SettingsPanel
              value={state.bootstrap.settings}
              shortcut={state.bootstrap.shortcut}
              close={() => {
                setShowSettings(false);
                requestAnimationFrame(() => settingsButton.current?.focus());
              }}
              save={async (settings) => {
                if (
                  settings.voiceEnabled === false ||
                  (settings.microphoneDevice !== undefined &&
                    settings.microphoneDevice !==
                      state.bootstrap?.settings.microphoneDevice)
                )
                  voice.stop();
                await store.settings(settings);
                const registered = store.getSnapshot().bootstrap?.shortcut;
                setNotice(
                  settings.shortcut && settings.shortcut !== registered
                    ? `Settings saved. Requested shortcut unavailable; ${registered ? `using ${registered}` : "use the menu bar"}.`
                    : "Settings saved on this device.",
                );
              }}
            />
          ) : (
            <>
              <p className="eyebrow">YOUR COMPANY, ON DEMAND</p>
              {notice && (
                <p className="notice" role="status">
                  {notice}
                </p>
              )}
              {state.pending > 0 && (
                <p className="pending-status" role="status">
                  <span className="status-pulse" aria-hidden="true" />
                  Working on your request. You can send an update below.
                </p>
              )}
              {!state.project && (
                <>
                  <h1>What are we making?</h1>
                  <p className="muted">
                    Give me an outcome. We’ll find the people and the path.
                  </p>
                </>
              )}
              {!state.project && state.bootstrap?.settings.lastProjectId && (
                <button
                  disabled={state.pending > 0}
                  onClick={() =>
                    run(
                      store.openProject(
                        state.bootstrap!.settings.lastProjectId!,
                      ),
                    )
                  }
                >
                  Resume previous project
                </button>
              )}
              {state.error && (
                <div role="alert" className="error">
                  {state.error}{" "}
                  {state.error.includes("Screen Recording permission") && (
                    <button
                      onClick={() =>
                        run(store.bridge.openPermissionSettings("screen"))
                      }
                    >
                      Open Screen Recording settings
                    </button>
                  )}
                  {state.connection === "offline" ? (
                    <button onClick={() => run(store.checkConnection())}>
                      Reconnect
                    </button>
                  ) : (
                    <button onClick={() => store.clearError()}>Dismiss</button>
                  )}
                </div>
              )}
              {!state.error && state.connection === "offline" && (
                <div className="error" role="alert">
                  Can’t reach Molecule right now.
                  <button onClick={() => run(store.checkConnection())}>
                    Reconnect
                  </button>
                </div>
              )}
              {audio.error && (
                <div role="alert" className="error">
                  {audio.error}
                  {audio.error.includes("Microphone access") && (
                    <button
                      onClick={() =>
                        run(store.bridge.openPermissionSettings("microphone"))
                      }
                    >
                      Open microphone settings
                    </button>
                  )}
                </div>
              )}
              {state.alert && (
                <aside
                  role="status"
                  className={`alert ${state.alert.severity}`}
                >
                  {state.alert.label}
                </aside>
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
              {voiceActive && (
                <div className="voice-controls">
                  <div
                    className={`waveform ${audio.muted ? "muted" : ""}`}
                    aria-label={
                      audio.muted
                        ? "Microphone muted"
                        : `Microphone ${audio.state}`
                    }
                  >
                    {[0.5, 0.85, 1, 0.65, 0.9, 0.5, 0.7].map(
                      (weight, index) => (
                        <i
                          key={index}
                          style={{
                            height: `${4 + audio.level * 26 * weight}px`,
                          }}
                        />
                      ),
                    )}
                  </div>
                  <span>{audio.muted ? "Muted" : audio.state}</span>
                  <button
                    aria-pressed={audio.muted}
                    onClick={() => voice.mute(!audio.muted)}
                  >
                    {audio.muted ? "Unmute" : "Mute"}
                  </button>
                  <button onClick={() => voice.interrupt()}>Interrupt</button>
                </div>
              )}
              {(audio.transcript || lastText) && (
                <div className="transcript">
                  <span>YOU</span>
                  <p>{audio.transcript || lastText}</p>
                </div>
              )}
              {audio.response && (
                <div className="transcript assistant" aria-live="polite">
                  <span>MOLECULE</span>
                  <p>{audio.response}</p>
                </div>
              )}
              {project?.intent?.ambiguityFlags.map((flag) => (
                <p className="question" key={flag.field}>
                  {flag.question ?? flag.reason}
                </p>
              ))}
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!text.trim()) return;
                  const intent = text.trim();
                  setLastText(intent);
                  if (voiceActive) voice.interrupt();
                  run(
                    store
                      .command({ name: "start_project", args: { intent } })
                      .then(() => {
                        setText((current) =>
                          current.trim() === intent ? "" : current,
                        );
                      }),
                  );
                }}
              >
                <label htmlFor="intent">Your request or next instruction</label>
                <textarea
                  ref={input}
                  id="intent"
                  placeholder="200 onboarding kits by Friday, under $7,000 CAD…"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  aria-describedby="intent-hint"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey) &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <small id="intent-hint" className="input-hint">
                  ⌘ / Ctrl + Enter to send · Enter for a new line
                </small>
                <button
                  className="primary"
                  disabled={!text.trim()}
                  type="submit"
                >
                  {state.pending
                    ? "Send updated instruction"
                    : "Build with Molecule"}
                </button>
              </form>
              <div className="context-tools">
                <input
                  ref={fileInput}
                  className="file-input"
                  type="file"
                  multiple
                  accept=".png,.jpg,.jpeg,.pdf,.csv,.txt,.json"
                  onChange={(event) => {
                    run(store.upload(Array.from(event.target.files ?? [])));
                    event.target.value = "";
                  }}
                />
                <button onClick={() => fileInput.current?.click()}>
                  ＋ Attach context
                </button>
                <button
                  ref={shareButton}
                  disabled={listingSources}
                  aria-expanded={!!sources}
                  onClick={() =>
                    run(
                      (async () => {
                        const request = ++screenRequest.current;
                        setListingSources(true);
                        try {
                          const items = await store.bridge.listScreenSources();
                          if (request !== screenRequest.current) return;
                          setSources(items);
                          setSourceId(items[0]?.id ?? "");
                        } catch (error) {
                          if (request !== screenRequest.current) return;
                          store.error(error);
                          setSources([]);
                        } finally {
                          if (request === screenRequest.current)
                            setListingSources(false);
                        }
                      })(),
                    )
                  }
                >
                  {listingSources
                    ? "Finding screens…"
                    : "Share screen / window"}
                </button>
              </div>
              {dragging && (
                <div className="drop-hint">
                  Drop files to attach to this project
                </div>
              )}
              <div className="attachments" aria-live="polite">
                {state.attachments.map((asset) => (
                  <span key={asset.assetId} title={asset.mimeType}>
                    ▧ {asset.name ?? asset.assetId}
                    <small>Attached</small>
                  </span>
                ))}
                {state.uploading.map((name, index) => (
                  <span className="uploading" key={`${name}-${index}`}>
                    {name}
                    <small>Uploading…</small>
                  </span>
                ))}
              </div>
              {sources && (
                <section className="screen-picker">
                  <h2 ref={sourceTitle} tabIndex={-1}>
                    Share one frame
                  </h2>
                  {!state.bootstrap?.settings.screenShareConsent && (
                    <p>
                      Only your selected source will be captured once and
                      uploaded to the Molecule backend. Microphone audio is not
                      included.
                    </p>
                  )}
                  {sources.length ? (
                    <>
                      <label>
                        Screen or window
                        <select
                          ref={sourceSelect}
                          value={sourceId}
                          onChange={(event) => setSourceId(event.target.value)}
                        >
                          {sources.map((source) => (
                            <option value={source.id} key={source.id}>
                              {source.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="primary"
                        onClick={() =>
                          run(
                            (async () => {
                              setSources(null);
                              await store.uploadFrom(async (signal) => [
                                await captureFrame(
                                  store.bridge,
                                  sourceId,
                                  signal,
                                ),
                              ]);
                              const settings =
                                store.getSnapshot().bootstrap?.settings;
                              if (settings)
                                await store.settings({
                                  screenShareConsent: true,
                                });
                            })(),
                          )
                        }
                      >
                        Share one frame
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() =>
                        run(store.bridge.openPermissionSettings("screen"))
                      }
                    >
                      Open Screen Recording settings
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setSources(null);
                      shareButton.current?.focus();
                    }}
                  >
                    Cancel
                  </button>
                </section>
              )}
              {project && (
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
                  <button
                    onClick={() => {
                      voice.stop();
                      run(store.newProject());
                      setLastText("");
                      setText("");
                      setSources(null);
                      screenRequest.current += 1;
                      setListingSources(false);
                    }}
                  >
                    New project
                  </button>
                  <button
                    disabled={
                      state.pending > 0 ||
                      [
                        "CANCELLED",
                        "COMPLETED",
                        "EXECUTING",
                        "SKU_CREATED",
                        "SUPPLIER_JOBS_CREATED",
                        "CUSTOMER_ORDER_CREATED",
                      ].includes(project.state)
                    }
                    onClick={() => {
                      voice.stop();
                      run(store.command({ name: "cancel_project", args: {} }));
                    }}
                  >
                    Cancel project
                  </button>
                </div>
              )}
              {project &&
                (state.mode === "company" || state.mode === "alert") && (
                  <TemporaryCompany
                    project={project}
                    failedMerchants={state.failedMerchants}
                  />
                )}
              {project?.intent?.hardConstraints.length ? (
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
              ) : null}
              {project?.state === "AWAITING_APPROVAL" &&
                project.activePlan?.status === "VALID" && (
                  <button
                    className="primary approve"
                    disabled={state.pending > 0}
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
              {state.project && (
                <>
                  <div className="section-title">
                    <h2>Activity</h2>
                    <span>
                      {state.project.state.replaceAll("_", " ").toLowerCase()}
                    </span>
                  </div>
                  <ol className="activity" aria-live="polite">
                    {[...state.activity]
                      .reverse()
                      .slice(0, 7)
                      .map((item) => (
                        <li key={item.id} className={item.severity}>
                          <span>
                            {item.label}
                            {item.merchantId && (
                              <small>{item.merchantId}</small>
                            )}
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
                  <button
                    onClick={() =>
                      run(store.bridge.openDashboard(state.project!.orderId))
                    }
                  >
                    Open Command Center ↗
                  </button>
                </>
              )}
              <details className="provider-status">
                <summary>
                  {state.marketplace
                    ? `${state.marketplace.mode} providers`
                    : "Provider availability unknown"}
                </summary>
                {state.marketplace?.providers.map((provider) => (
                  <p key={provider.name}>
                    <strong>{provider.name}</strong> · {provider.mode} ·{" "}
                    {provider.status}
                    <small>{provider.detail}</small>
                  </p>
                ))}
                {state.providerError && (
                  <p role="status">{state.providerError}</p>
                )}
                {state.marketplace && (
                  <small>
                    Checked{" "}
                    {new Date(
                      state.marketplace.generatedAt,
                    ).toLocaleTimeString()}
                  </small>
                )}
                <button onClick={() => run(store.refreshProviders())}>
                  Refresh availability
                </button>
              </details>
              {!state.marketplace && state.mockProviders.length > 0 && (
                <p className="demo-note">
                  Development providers: {state.mockProviders.join(", ")} are
                  mocked.
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
              <footer>
                <span>{state.bootstrap?.shortcut ?? "Menu bar"} to return</span>
                <button
                  ref={settingsButton}
                  onClick={() => {
                    screenRequest.current += 1;
                    setSources(null);
                    setListingSources(false);
                    setShowSettings(true);
                  }}
                >
                  Settings
                </button>
              </footer>
            </>
          )}
        </div>
      )}
    </main>
  );
}
