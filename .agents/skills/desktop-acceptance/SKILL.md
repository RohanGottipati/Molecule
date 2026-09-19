---
name: molecule-linux-desktop-acceptance
description: Exercise Molecule's Electron dock, context approval and cross-surface handoff on Linux with synthetic providers or explicitly authorized live voice.
---

# Linux Electron UI acceptance

## Devin Secrets Needed

None for synthetic providers. Do not enable paid providers unless explicitly authorized.
For authorized live OpenAI acceptance, bind a session-scoped `OPENAI_API_KEY` only
to the backend process. Never log keys, session responses, authorization headers,
or ephemeral tokens. Virtual audio does not establish physical-media acceptance.

## Setup

- Read the environment blueprint, docs/DESKTOP.md and browser-acceptance skill.
- Use its isolated PostgreSQL, synthetic provider safeguards and real CP-SAT setup.
- Current database migrations require both TimescaleDB and pgvector. Use a fresh acceptance database, never adapter/runtime-test databases; migrate and seed it before starting the services.
- Build desktop before launch. In the Linux container, Electron may require `--no-sandbox`; use this only for the isolated container, not a production deployment.
- Launch `pnpm --filter @molecule/desktop exec electron . --no-sandbox --remote-debugging-port=9223 --user-data-dir=<isolated home directory>` with ORCHESTRATOR_URL and WEB_APP_URL pointing to the matching acceptance services.
- Keep CDP local and use it only for read-only diagnostics.
- Electron starts hidden. Ctrl+Shift+M is the Linux shortcut fallback. Use the header chevron to expand/collapse the current input dock.
- Stop the actual Electron child before relaunching; stopping its package launcher alone can leave its CDP port occupied.
- Backend status can be stale if the backend started after Electron; use its visible Reconnect control when offered before diagnosing connectivity.

## Unpackaged Linux URI continuation

Unpackaged Electron may not register `molecule://` with the desktop. If Continue
in dock does not reach the running acceptance instance:

1. Inspect `xdg-mime query default x-scheme-handler/molecule` and preserve any existing handler.
2. Resolve the executable from the current checkout's desktop workspace with `node -p "require('electron')"`; do not hard-code a pnpm version directory.
3. Create a temporary user `.desktop` entry in the verified `$XDG_DATA_HOME/applications` directory (or `$HOME/.local/share/applications`). Set `Type=Application`, `Terminal=false`, and `MimeType=x-scheme-handler/molecule;`.
4. Its `Exec` must use the resolved Electron executable, absolute `apps/desktop` directory, the same isolated `--user-data-dir` as the running app, applicable container flag, and trailing `%u`. Quote paths according to desktop-entry syntax.
5. Temporarily select that entry using `xdg-mime default <entry-name>.desktop x-scheme-handler/molecule`.
6. Test the real browser link and OS confirmation. Verify matching project UUID, attachments and plan on web → dock → web.
7. Restore the previous handler and remove the temporary entry after acceptance. Do not bake a session-specific handler/profile into the environment blueprint.

This verifies unpackaged Linux handoff, not packaged application registration or
macOS behavior. Keep the acceptance Electron instance running so URI delivery
reaches its configured services.

## UI checks

- Settings is in the expanded dock footer. Confirm unchanged Save is disabled.
- Change voice/notification preferences, save, reopen and verify persistence.
- Change a preference without saving; Escape should discard the draft and return focus to Settings. Enter should reopen it.
- Share screen/window must show an explicit picker. Escape should return focus to its trigger. Select only a synthetic local screen/window; Add one frame stages context, not continuous capture. Send and then compile via a brief update, or verify a bounded actionable error.
- Without a microphone, Talk should produce actionable Settings guidance rather than a stuck recording state. Restore voice disabled afterward. Missing-device coverage does not certify an OS permission-denial dialog.
- For a valid company overlay, use a fresh or uncommitted dataset. A prior supplier outage and committed reservations can independently cause UNSAT; do not paraphrase the canonical brief to bypass that state.
- Submit the exact required brief with Enter; Shift+Enter inserts a newline. Inspect the seven-node/six-link company, expand a node, and check budget/deadline.
- Escape closes settings/picker first, otherwise collapses an expanded dock, then hides a compact dock. Hiding stops voice; collapsing should preserve the same connection. The shortcut focuses a visible unfocused dock, then hides it when already focused.
- Linux screen frames and missing-device errors do not certify native macOS permission dialogs, physical microphone/audio, or live-provider execution.

## Context approval and shared project state

- Stage a file, verify its removable chip, and remove it before sending. A staged chip is not a persisted attachment.
- Invalid-file rejection must retain a removable failed chip and must not silently submit the text draft.
- A lost successful attachment response needs a transport fixture. Verify stable action ID, one upload, one attached asset and one `context.attached` event. Automatic recovery alone does not establish persistent-unknown/manual retry coverage.
- Staged, uploading, uncertain and uncompiled context must block dock approval. After confirmed attachment, both surfaces must instruct the user to submit a text brief update.
- Submit an actual brief update to compile new context. Typed constraint commands and `request_recompile` do not establish compilation of newly attached context. Verify the compiled intent contains the attached asset ID and checksum (or URL when no checksum exists), then verify explicit approval becomes available.
- With synthetic commerce, verify approval before compilation returns HTTP409 without changing the project or emitting `execution.started`; after compilation, approval can complete. `pnpm verify:desktop` and `pnpm verify:kit` exercise this sequence with real CP-SAT.
- Hide/reopen during a genuinely pending solve. If a timing proxy is needed, keep delay below the solver client's timeout; six seconds worked during acceptance, while fifteen seconds exceeded the ten-second timeout.
- New project must clear prior staged context, draft, recent turns and tool scope. A late old-project response must not repopulate the new selection.
- Verify cancellation remains cancelled after the delayed response and reload. For revision races, verify the rejected retry retains its original action identity/revision rather than applying stale text.

## Authorized live OpenAI with controlled audio

- Read current official OpenAI WebRTC/conversation endpoint documentation before
  live requests. Use a bounded connection/time budget. Retain Backboard/Shopify
  mocks and `REAL_EXECUTION_ENABLED=false`; no commerce approval is needed to
  verify voice transport.
- Install `pulseaudio pulseaudio-utils` if absent; FFmpeg must include `flite`.
  Start PulseAudio with idle exit disabled. Create separate null sinks for input
  fixtures and assistant output, then remap only the input monitor as a source:
  `pactl load-module module-remap-source master=<input>.monitor source_name=<mic>`.
  Set that source and the separate output sink as defaults, or bind `PULSE_SOURCE`
  and `PULSE_SINK` to Electron. Never loop assistant output into its microphone.
- Generate speech with FFmpeg/flite and feed it with `paplay --device=<input>`.
  Quiet/loud fixture amplitudes can be partially normalized by capture AGC:
  compare actual measured levels, not source-file amplitude alone.
- Inspect the existing voice instance read-only: sender track identity must match
  the metered capture track; the analyser source's mediaStream must be that same
  stream. Do not replace getUserMedia, inject level values, or invoke voice
  actions through diagnostic hooks. Mute must disable the actual track and
  suppress transcript/level updates for a fixture played while muted.
- Resource references should be retained only once the connection is established
  and the metering AudioContext exists. After Stop/hide, verify retained peers
  closed, tracks ended, AudioContexts closed, and current RAF/source/analyser
  references cleared. Inspection must never serialize the session secret.
- To test genuine automatic recovery, inspect selected remote ICE endpoints and
  temporarily block only their UDP traffic with a short, automatically removed
  firewall rule. Confirm real dropped packets, the reconnecting state, a new
  peer, and a fresh audio exchange without UI reconnect/reload. Remove every
  test rule. Manual Stop/Start alone does not certify automatic recovery.
- Screen-recording tools may aggressively accelerate periods without mouse
  activity, even while speech plays. Keep a real-time source-video version for
  voice evidence. Capture the isolated input/output monitor audio separately
  (e.g. input left, assistant right), align it to the source video, and disclose
  approximate A/V alignment rather than using it to claim millisecond latency.
- Distinguish interruption of buffered assistant playback from cancellation of
  an actively generating response/tool. Only claim the states actually observed.
  For active-generation coverage, request a long spoken explanation, then feed
  a fresh microphone instruction while `responseFinished=false` and no matching
  `response.done` has arrived. Observe real cancellation/buffer-clear events,
  the new transcript and durable tool receipt; never inject response events.
  Semantic VAD may cancel first (`reason=turn_detected`), followed by a redundant
  `response_cancel_not_active` error from the client cancel. Disclose this race;
  do not claim that the explicit client cancel was accepted.
- For live planning, start from an unresumed dock to create a fresh project
  before voice connects. Switching projects stops voice and costs a new session.
  Match Realtime call IDs to durable action receipts and project events. Verify
  corrections increase intent version and preserve existing requirements.
  Missing artwork, recipient-name data or shipping destinations may legitimately
  prevent a valid kit plan. Record the exact clarification/solver result rather
  than inventing facts or applying generic budget/deadline relaxations.
  A completed backend action is reconciled by a later correction, not rolled
  back by audio interruption. Cancellation of an undispatched tool requires
  separate observed evidence; voice interruption alone does not establish it.
- Cleanup:
  Stop voice and the secret-bearing backend at the end; remove temporary audio
  routes. No physical microphone or native macOS claim follows from virtual audio.
