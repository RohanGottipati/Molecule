---
name: molecule-linux-desktop-acceptance
description: Exercise Molecule's actual Electron dock, settings, screen picker and solver plan on Linux without live providers.
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
- Build desktop before launch. In the Linux container, Electron may require `--no-sandbox`; use this only for the isolated container, not a production deployment.
- Launch `pnpm --filter @molecule/desktop exec electron . --no-sandbox --remote-debugging-port=9223 --user-data-dir=<isolated home directory>` with ORCHESTRATOR_URL and WEB_APP_URL pointing to the matching acceptance services.
- Keep CDP local and use it only for read-only diagnostics.
- Electron starts hidden. Ctrl+Shift+M is the Linux shortcut fallback. Use the header chevron to expand/collapse the current input dock.
- Stop the actual Electron child before relaunching; stopping its package launcher alone can leave its CDP port occupied.
- Backend status can be stale if the backend started after Electron; use its visible Reconnect control when offered before diagnosing connectivity.

## UI checks

- Settings is in the expanded dock footer. Confirm unchanged Save is disabled.
- Change voice/notification preferences, save, reopen and verify persistence.
- Change a preference without saving; Escape should discard the draft and return focus to Settings. Enter should reopen it.
- Share screen/window must show an explicit picker. Escape should return focus to its trigger. Select only a synthetic local screen/window and verify a frame attachment or bounded actionable error.
- Without a microphone, Talk should produce actionable Settings guidance rather than a stuck recording state. Restore voice disabled afterward.
- For a valid company overlay, use a fresh or uncommitted dataset. A prior supplier outage and committed reservations can independently cause UNSAT; do not paraphrase the canonical brief to bypass that state.
- Submit the exact required brief with Enter; Shift+Enter inserts a newline. Inspect the seven-node/six-link company, expand a node, and check budget/deadline.
- Escape closes settings/picker first, otherwise collapses an expanded dock, then hides a compact dock. Hiding stops voice; collapsing should preserve the same connection. The shortcut focuses a visible unfocused dock, then hides it when already focused.
- Linux screen frames and missing-device errors do not certify native macOS permission dialogs, physical microphone/audio, or live-provider execution.

## Authorized live OpenAI with controlled audio

- Read current official OpenAI WebRTC/conversation endpoint documentation before
  live requests. Use a bounded connection/time budget. Retain Backboard/Shopify
  mocks and `REAL_EXECUTION_ENABLED=false`; no commerce approval is needed to
  verify voice transport.
- Current database migrations require both TimescaleDB and pgvector. Use a fresh
  acceptance database, never adapter/runtime-test databases; migrate and seed it
  before starting the services.
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
  Stop voice and the secret-bearing backend at the end; remove temporary audio
  routes. No physical microphone or native macOS claim follows from virtual audio.
