import { useEffect, useState } from "react";
import type { Settings } from "../../shared/bridge.js";

export function SettingsPanel({
  value,
  shortcut,
  save,
  close,
}: {
  value: Settings;
  shortcut: string | null;
  save: (settings: Settings) => Promise<void>;
  close: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((all) =>
        setDevices(all.filter((item) => item.kind === "audioinput")),
      )
      .catch(() => setError("Microphone devices are unavailable."));
  }, []);
  return (
    <section className="settings">
      <div className="section-title">
        <h2>Settings</h2>
        <button onClick={close} aria-label="Close settings">
          ×
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setError("");
          void save(draft)
            .then(close)
            .catch((cause: unknown) =>
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Settings could not be saved",
              ),
            )
            .finally(() => setSaving(false));
        }}
      >
        <label>
          Global shortcut
          <input
            value={draft.shortcut}
            onChange={(event) =>
              setDraft({ ...draft, shortcut: event.target.value })
            }
            required
          />
        </label>
        <p className="muted">
          Registered: {shortcut ?? "Unavailable — use the menu bar"}.
          Option+Shift+Space toggles voice.
        </p>
        <label>
          Microphone
          <select
            value={draft.microphoneDevice}
            onChange={(event) =>
              setDraft({ ...draft, microphoneDevice: event.target.value })
            }
          >
            <option value="">System default</option>
            {devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label ||
                  `Microphone ${index + 1} (permission not yet granted)`}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.voiceEnabled}
            onChange={(event) =>
              setDraft({ ...draft, voiceEnabled: event.target.checked })
            }
          />
          Enable voice
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.notificationsEnabled}
            onChange={(event) =>
              setDraft({ ...draft, notificationsEnabled: event.target.checked })
            }
          />
          Notify me about important events while hidden
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.autoExpandOnAlert}
            onChange={(event) =>
              setDraft({ ...draft, autoExpandOnAlert: event.target.checked })
            }
          />
          Expand for critical alerts
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={draft.screenShareConsent}
            onChange={(event) =>
              setDraft({ ...draft, screenShareConsent: event.target.checked })
            }
          />
          Remember screen-sharing explanation
        </label>
        <p className="muted">
          Each screen capture still requires selecting a source and pressing
          Share one frame. Secrets are never saved here.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </section>
  );
}
