import { useEffect, useRef, useState } from "react";
import type { ScreenSource } from "../../shared/bridge.js";
import type { DesktopStore } from "../state/desktop-store.js";
import { captureFrame } from "../services/screen-context.js";

export function ScreenPicker({
  store,
  close,
}: {
  store: DesktopStore;
  close: () => void;
}) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [capturing, setCapturing] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    let cancelled = false;
    title.current?.focus();
    void store.bridge
      .listScreenSources()
      .then((items) => {
        if (cancelled) return;
        setSources(items);
        setSourceId(items[0]?.id ?? "");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        store.error(error);
        setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [store]);
  useEffect(() => {
    if (sources?.length) select.current?.focus();
  }, [sources]);
  return (
    <section
      className="screen-picker"
      role="region"
      aria-labelledby="screen-title"
    >
      <h2 ref={title} id="screen-title" tabIndex={-1}>
        Share one frame
      </h2>
      <p>
        Choose a screen or window. One image will be added to your draft;
        nothing is recorded continuously.
      </p>
      {sources === null ? (
        <p role="status">Finding screens and windows…</p>
      ) : sources.length ? (
        <>
          <label>
            Screen or window
            <select
              ref={select}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={capturing}
            onClick={() => {
              setCapturing(true);
              void store
                .uploadFrom(
                  async (signal) => [
                    await captureFrame(store.bridge, sourceId, signal),
                  ],
                  true,
                )
                .then(async () => {
                  await store.settings({ screenShareConsent: true });
                  close();
                })
                .catch((error: unknown) => store.error(error))
                .finally(() => setCapturing(false));
            }}
          >
            {capturing ? "Capturing…" : "Add one frame"}
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            void store.bridge
              .openPermissionSettings("screen")
              .catch((error: unknown) => store.error(error));
          }}
        >
          Open Screen Recording settings
        </button>
      )}
      <button onClick={close} disabled={capturing}>
        Cancel
      </button>
    </section>
  );
}
