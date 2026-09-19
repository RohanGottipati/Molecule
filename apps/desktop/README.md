# Desktop overlay

See [desktop architecture](../../docs/DESKTOP.md) for Electron boundaries,
service configuration, packaging, and native acceptance requirements.

## Interaction

- The Molecule orb expands/collapses the dock. Talk and the voice shortcut
  open the conversation, including permission and connection errors.
- Command+Enter or Ctrl+Enter submits an instruction. Enter inserts a new
  line. A failed instruction stays in the composer for correction or retry;
  a successful response never clears a newer draft.
- Escape dismisses the screen picker or settings first, then hides the
  overlay. Closing a picker/settings returns focus to its entry control.
- Production stages preserve backend graph dependencies. Tab to a node,
  then Enter or Space to inspect quantity, risk confidence, and incoming
  material connections. Displayed feasibility comes only from the backend.
- Settings submit only edited preferences. Device lists refresh when
  microphones change; an unavailable saved device remains visible.
- Shared motion duration/easing variables live in `src/renderer/styles.css`.
  Reduced-motion preferences disable animation and transitions.

## Lifecycle and persistence

`DesktopBridge.saveSettings(SettingsPatch)` accepts an optional-field patch
validated by `SettingsPatchSchema`. Defaults apply only to complete settings,
not patches. `SettingsStore.update` merges against the last successfully
persisted value **inside** the serialized atomic-write queue. Window moves,
resume-project updates, and settings edits therefore preserve each other's
fields. The renderer also serializes settings requests; the main process
registers shortcuts only after persistence succeeds.

`DesktopStore.uploadFrom` passes an `AbortSignal` to the acquisition callback.
Hiding the overlay, switching projects, or disposing the store cancels pending
capture; a late source is released instead of uploaded. Single-frame capture
has a five-second frame/playback deadline, includes no audio, and releases
tracks and video callbacks on success, failure, timeout, or cancellation.
Already accepted backend operations are not rolled back on hide.

Voice connection setup has a thirty-second deadline after microphone
acquisition, including backend refresh, grant creation, and peer negotiation.
Timeout releases local media and follows the existing bounded reconnect
policy. Permission prompts remain user-controlled. A late setup result cannot
continue a stopped or superseded conversation.

## Checks

After the root bootstrap:

```sh
pnpm exec prettier --check apps/desktop
pnpm --filter @molecule/desktop lint
pnpm --filter @molecule/desktop typecheck
pnpm --filter @molecule/desktop test
pnpm --filter @molecule/desktop build
pnpm verify:desktop
DESKTOP_VERIFY_SCENARIO=kit pnpm verify:desktop
```

The verification scripts use mock providers and the local Python CP-SAT
solver. Neither shell tests nor a Linux build establish macOS permission,
hotkey, physical microphone, notification, live WebRTC, signing, or
notarization acceptance. Those need separate native verification.
