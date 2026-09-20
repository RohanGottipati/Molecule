import { useEffect, useRef, useState } from "react";
import type { Settings, SettingsPatch } from "../../shared/bridge.js";

export function SettingsPanel({
  value,
  shortcut,
  save,
  close,
}: {
  value: Settings;
  shortcut: string | null;
  save: (settings: SettingsPatch) => Promise<void>;
  close: () => void;
}) {
  const [changes, setChanges] = useState<SettingsPatch>({});
  const draft = { ...value, ...changes };
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    title.current?.focus();
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) {
      setDeviceError(
        "Microphone devices are unavailable. You can still save other preferences.",
      );
      return () => {
        mounted.current = false;
      };
    }
    let active = true;
    const refresh = () => {
      void media
        .enumerateDevices()
        .then((all) => {
          if (!active) return;
          setDevices(all.filter((item) => item.kind === "audioinput"));
          setDeviceError("");
        })
        .catch(() => {
          if (active)
            setDeviceError(
              "Microphone devices are unavailable. You can still save other preferences.",
            );
        });
    };
    refresh();
    media.addEventListener("devicechange", refresh);
    return () => {
      mounted.current = false;
      active = false;
      media.removeEventListener("devicechange", refresh);
    };
  }, []);
  return (
    <section className="settings">
      <div className="section-title">
        <div>
          <p className="eyebrow">MAKE IT YOURS</p>
          <h2 ref={title} tabIndex={-1}>
            Settings
          </h2>
        </div>
        <button onClick={close} aria-label="Close settings">
          ×
        </button>
      </div>
      <p className="muted">Your workspace preferences stay on this device.</p>
      <form
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setError("");
          void save(changes)
            .then(() => {
              if (mounted.current) close();
            })
            .catch((cause: unknown) => {
              if (mounted.current)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Settings could not be saved",
                );
            })
            .finally(() => {
              if (mounted.current) setSaving(false);
            });
        }}
      >
        <fieldset disabled={saving}>
          <legend>Access &amp; voice</legend>
          <label>
            Global shortcut
            <input
              value={draft.shortcut}
              onChange={(event) =>
                setChanges({ ...changes, shortcut: event.target.value })
              }
              required
              maxLength={80}
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
                setChanges({ ...changes, microphoneDevice: event.target.value })
              }
            >
              <option value="">System default</option>
              {draft.microphoneDevice &&
                !devices.some(
                  (device) => device.deviceId === draft.microphoneDevice,
                ) && (
                  <option value={draft.microphoneDevice}>
                    Saved microphone (currently unavailable)
                  </option>
                )}
              {devices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label ||
                    `Microphone ${index + 1} (permission not yet granted)`}
                </option>
              ))}
            </select>
          </label>
          {deviceError && (
            <p role="status" className="muted">
              {deviceError}
            </p>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.voiceEnabled}
              onChange={(event) =>
                setChanges({ ...changes, voiceEnabled: event.target.checked })
              }
            />
            Enable voice
          </label>
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Attention &amp; privacy</legend>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.notificationsEnabled}
              onChange={(event) =>
                setChanges({
                  ...changes,
                  notificationsEnabled: event.target.checked,
                })
              }
            />
            Notify me about important events while hidden
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.autoExpandOnAlert}
              onChange={(event) =>
                setChanges({
                  ...changes,
                  autoExpandOnAlert: event.target.checked,
                })
              }
            />
            Expand for critical alerts
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.screenShareConsent}
              onChange={(event) =>
                setChanges({
                  ...changes,
                  screenShareConsent: event.target.checked,
                })
              }
            />
            Remember screen-sharing explanation
          </label>
          <p className="muted">
            Each screen capture still requires selecting a source and pressing
            Share one frame. Secrets are never saved here.
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="primary"
          disabled={saving || !Object.keys(changes).length}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </section>
  );
}
