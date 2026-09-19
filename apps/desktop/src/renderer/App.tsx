import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DesktopStore } from "./state/desktop-store.js";
import { useVoice } from "./useVoice.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import {
  DockConversation,
  type TextTurn,
} from "./components/DockConversation.js";
import { VoiceInput, voiceLabel } from "./components/MoleculeInput.js";
import { DockIcon } from "./components/DockIcon.js";
import { ScreenPicker } from "./components/ScreenPicker.js";

export function App() {
  const [store] = useState(() => new DesktopStore(window.moleculeDesktop));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { voice, state: audio, toggle: toggleVoice } = useVoice(store);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<TextTurn[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showScreen, setShowScreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [sendingContext, setSendingContext] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const submitted = useRef(new Set<string>());
  const selection = useRef(0);
  const compact = state.mode === "compact";
  const voiceActive = !["idle", "error"].includes(audio.state);
  const run = (operation: Promise<unknown>) => {
    void operation.catch((error: unknown) => store.error(error));
  };
  const stage = (files: File[]) => {
    try {
      store.stage(files);
      if (files.length) run(store.mode("conversation"));
    } catch (error) {
      store.error(error);
      run(store.mode("conversation"));
    }
  };
  const closeScreen = () => {
    setShowScreen(false);
    input.current?.focus();
  };
  useEffect(() => {
    void store.initialize().then(() => store.refreshProviders());
    const timer = setInterval(() => {
      void store.refreshProviders();
    }, 60_000);
    const unsubscribe = store.bridge.onSignal((signal) => {
      if (signal.type === "visibility") {
        store.setVisible(signal.visible);
        setDragging(false);
        if (!signal.visible) setShowScreen(false);
      }
      if (signal.type === "project") {
        selection.current += 1;
        submitted.current.clear();
        setSendingContext(false);
        setText("");
        setTurns([]);
        setShowScreen(false);
        setShowSettings(false);
        run(store.openProject(signal.projectId));
      }
      if (signal.type === "settings") {
        setShowScreen(false);
        setShowSettings(true);
        run(store.mode("conversation"));
      }
      if (signal.type === "start-voice") setShowSettings(false);
    });
    return () => {
      unsubscribe();
      clearInterval(timer);
      store.dispose();
    };
  }, [store]);
  useEffect(() => {
    if (state.visible && !showSettings && !showScreen && document.hasFocus())
      input.current?.focus();
  }, [state.visible, state.mode, showSettings, showScreen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      event.preventDefault();
      if (showScreen) closeScreen();
      else if (showSettings) {
        setShowSettings(false);
        requestAnimationFrame(() => settingsButton.current?.focus());
      } else if (store.getSnapshot().mode !== "compact")
        run(store.mode("compact"));
      else run(store.bridge.hideOverlay());
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [store, showSettings, showScreen]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const submit = async () => {
    const intent = text.trim();
    if (
      (!intent && !state.staged.length) ||
      sendingContext ||
      submitted.current.has(intent)
    )
      return;
    const current = selection.current;
    submitted.current.add(intent);
    if (voiceActive) voice.interrupt();
    run(store.mode("conversation"));
    try {
      setSendingContext(true);
      await store.flushContext();
      if (current !== selection.current) return;
      setSendingContext(false);
      if (!intent) {
        setNotice("Context added. Tell Molecule how to use it.");
        return;
      }
      const id = crypto.randomUUID();
      setTurns((history) => [...history, { id, text: intent }].slice(-12));
      const result = await store.command({
        name: "start_project",
        args: { intent },
      });
      if (current !== selection.current) return;
      voice.context(result);
      setText((draft) => (draft.trim() === intent ? "" : draft));
    } finally {
      if (current === selection.current) {
        setSendingContext(false);
        submitted.current.delete(intent);
      }
    }
  };
  const latest = state.activity.at(-1)?.label;
  const status = state.error
    ? "Action needs attention"
    : audio.error
      ? "Voice needs attention"
      : (state.alert?.label ??
        (voiceActive
          ? voiceLabel(audio)
          : state.connection !== "connected"
            ? `Backend ${state.connection}`
            : state.pending
              ? (latest ?? "Working on your request")
              : "Ready when you are"));
  return (
    <main
      className={`overlay ${dragging ? "dragging" : ""}`}
      data-mode={state.mode}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
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
        stage(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        if (showSettings) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length) {
          event.preventDefault();
          stage(files);
        }
      }}
    >
      <header className="dock-header drag-region">
        <span className="molecule-mark" aria-hidden="true">
          m
        </span>
        <div className="brand">
          <strong>Molecule</strong>
          <button
            className="header-status"
            onClick={() => run(store.mode("conversation"))}
            title={status}
          >
            {status}
          </button>
        </div>
        <button
          className="icon-button"
          aria-label="Open Command Center"
          title="Continue this project in Command Center"
          onClick={() =>
            run(store.bridge.openDashboard(state.project?.orderId))
          }
        >
          <DockIcon name="command" />
        </button>
        <button
          className="icon-button"
          aria-label={compact ? "Expand Molecule" : "Collapse Molecule"}
          aria-expanded={!compact}
          title={compact ? "Show conversation" : "Collapse conversation"}
          onClick={() => {
            setShowSettings(false);
            run(store.mode(compact ? "conversation" : "compact"));
          }}
        >
          <DockIcon name={compact ? "expand" : "collapse"} />
        </button>
        <button
          className="icon-button"
          aria-label="Hide Molecule"
          title="Hide Molecule"
          onClick={() => run(store.bridge.hideOverlay())}
        >
          <DockIcon name="close" />
        </button>
      </header>
      {!compact && (
        <div className="content" id="conversation">
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
                const shortcut = store.getSnapshot().bootstrap?.shortcut;
                setNotice(
                  settings.shortcut && settings.shortcut !== shortcut
                    ? `Requested shortcut unavailable; ${shortcut ? `using ${shortcut}` : "use the menu bar"}.`
                    : "Settings saved on this device.",
                );
              }}
            />
          ) : (
            <>
              {showScreen && <ScreenPicker store={store} close={closeScreen} />}
              <DockConversation
                store={store}
                state={state}
                audio={audio}
                turns={turns}
                onNew={() => {
                  selection.current += 1;
                  submitted.current.clear();
                  setSendingContext(false);
                  run(store.newProject());
                  setText("");
                  setTurns([]);
                  setShowScreen(false);
                }}
                onCancel={() => {
                  voice.stop();
                  run(store.command({ name: "cancel_project", args: {} }));
                }}
              />
            </>
          )}
        </div>
      )}
      {!compact && (
        <div className="feedback">
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {(state.error || state.connection === "offline") && (
            <div className="error" role="alert">
              <span>{state.error ?? "Can’t reach Molecule right now."}</span>
              <div className="feedback-actions">
                {state.error?.includes("Screen Recording") && (
                  <button
                    onClick={() =>
                      run(store.bridge.openPermissionSettings("screen"))
                    }
                  >
                    Screen permissions
                  </button>
                )}
                <button
                  onClick={() =>
                    state.connection === "offline"
                      ? run(store.checkConnection())
                      : store.clearError()
                  }
                >
                  {state.connection === "offline" ? "Reconnect" : "Dismiss"}
                </button>
              </div>
            </div>
          )}
          {audio.error && (
            <div className="error" role="alert">
              <span>{audio.error}</span>
              <div className="feedback-actions">
                {audio.error.includes("Microphone access") && (
                  <button
                    onClick={() =>
                      run(store.bridge.openPermissionSettings("microphone"))
                    }
                  >
                    Microphone permissions
                  </button>
                )}
                {audio.state !== "reconnecting" && (
                  <button
                    onClick={() => {
                      voice.stop();
                      run(toggleVoice());
                    }}
                  >
                    Retry voice
                  </button>
                )}
                <button
                  onClick={() => {
                    voice.stop();
                    input.current?.focus();
                  }}
                >
                  Use text
                </button>
              </div>
            </div>
          )}
          {state.alert && (
            <aside role="status" className={`alert ${state.alert.severity}`}>
              {state.alert.label}
            </aside>
          )}
        </div>
      )}
      <div className="input-dock">
        {dragging && (
          <div className="drop-hint" role="status">
            Drop to add context · send when you’re ready
          </div>
        )}
        <VoiceInput
          voice={voice}
          visible={state.visible}
          inputRef={input}
          text={text}
          onText={setText}
          onSubmit={() => run(submit())}
          onVoice={() => {
            setShowSettings(false);
            run(toggleVoice());
          }}
          onMute={() => voice.mute(!audio.muted)}
          onInterrupt={() => voice.interrupt()}
          onAttach={() => fileInput.current?.click()}
          onScreen={() => {
            setShowScreen(true);
            setShowSettings(false);
            run(store.mode("conversation"));
          }}
          onRemove={(id) => store.removeStaged(id)}
          compact={compact}
          audio={audio}
          staged={state.staged}
          sending={sendingContext}
          pending={state.pending > 0}
          status={
            sendingContext
              ? "Adding context…"
              : state.pending
                ? (latest ?? "Working on your request")
                : undefined
          }
        />
      </div>
      <input
        ref={fileInput}
        className="file-input"
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.pdf,.csv,.txt,.json"
        aria-label="Choose context files"
        onChange={(event) => {
          stage(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {!compact && (
        <footer className="dock-footer">
          <button
            className="command-center"
            onClick={() =>
              run(store.bridge.openDashboard(state.project?.orderId))
            }
          >
            Command Center <DockIcon name="command" />
          </button>
          <button
            title="Add clipboard files, images, or text as context"
            onClick={() =>
              run(
                store.uploadFrom(
                  async () =>
                    (await store.bridge.pasteFiles()).map(
                      (file) =>
                        new File([new Uint8Array(file.bytes)], file.name, {
                          type: file.mimeType,
                        }),
                    ),
                  true,
                ),
              )
            }
          >
            Paste context
          </button>
          <button
            ref={settingsButton}
            className="icon-button"
            aria-label="Settings"
            title="Molecule settings"
            onClick={() => {
              setShowScreen(false);
              setShowSettings(true);
            }}
          >
            <DockIcon name="settings" />
          </button>
        </footer>
      )}
    </main>
  );
}
