# Molecule macOS control surface

The Electron overlay controls the existing `OrderSession` orchestrator. It does not match merchants, certify plans, or call commerce providers. The `openai` branch supplies the web workspace, OpenAI adapter, orchestrator, and deterministic Python solver. Reality/Tiger, merchant/Backboard, and Shopify clients on that branch are **mocks**. The overlay labels them as such; a Shopify event in this checkout represents a mock result.

## Run locally

Prerequisites: Node 22+, Corepack/pnpm 10.14.0, Python 3.12+, and macOS for native acceptance. From the repository root:

```bash
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
python3.12 -m venv services/solver/.venv
services/solver/.venv/bin/pip install -r services/solver/requirements-dev.txt
pnpm --filter @molecule/contracts build
pnpm --filter @molecule/openai build
```

Use separate terminals:

```bash
pnpm solver:dev
DEMO_MODE=true pnpm --filter @molecule/orchestrator dev
pnpm --filter @molecule/desktop dev
```

The desktop launches hidden. Press **Option+Space**; the fallback is **Command+Shift+M**. The web app is optional until opening Command Center:

```bash
pnpm --filter @molecule/web dev
```

Settings and the menu-bar item provide alternate ways to open the overlay. The activation shortcut focuses a visible dock when another app has focus; invoking it again while Molecule is focused hides it. **Option+Shift+Space toggles voice**; Electron `globalShortcut` does not provide reliable key-up events, so this is not hold-to-talk.

The compact dock includes the primary input, voice, attachment, send, and expand controls. **Enter sends**, **Shift+Enter inserts a newline**, and Ctrl/Command+Enter also sends. Escape closes the screen picker or settings first, then collapses the conversation, then hides the dock. Collapsing retains the draft, staged context, transcript, and active voice connection; hiding releases microphone resources. The conversation scrolls independently above the input. Command Center opens the same project.

Environment files are not automatically loaded by the orchestrator. Export server variables in its terminal or use a Node environment-file launcher with your private environment file. Do not export server credentials into the desktop terminal. Empty secret placeholders in `.env.example` must be omitted rather than supplied as empty values.

### Server configuration

| Variable                     | Meaning                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`             | Server-only key; required for real OpenAI                                            |
| `USE_MOCK_OPENAI`            | Defaults to `true`; mock mode offers text, not synthetic voice                       |
| `OPENAI_REALTIME_MODEL`      | Account-supported Realtime model; existing default is retained                       |
| `OPENAI_COMPILER_MODEL`      | Account-supported structured-output/multimodal compiler                              |
| `OPENAI_TRANSCRIPTION_MODEL` | Added; defaults to `gpt-4o-mini-transcribe`                                          |
| `SOLVER_URL`                 | Existing solver endpoint, default `http://localhost:8000`                            |
| `HOST`                       | Added; defaults to loopback `127.0.0.1`                                              |
| `DATA_DIR`                   | Added; defaults to `.molecule-data` relative to the server working directory         |
| `DESKTOP_ORIGIN`             | Added; dev origin `http://127.0.0.1:5173`; packaged `app://molecule` is also allowed |
| `ALLOWED_ORIGIN`             | Existing web origin, default `http://localhost:3000`                                 |
| `DEMO_MODE`                  | Enables the existing supplier-offline chaos endpoint                                 |
| `CHAOS_SECRET`               | Existing protection for remote chaos calls; desktop demo requires a local backend    |

Desktop-only configuration: `ORCHESTRATOR_URL` (default port 3001), `WEB_APP_URL` (default port 3000). `DESKTOP_RENDERER_URL` is set by the dev launcher and accepts only local hosts. The app opens `${WEB_APP_URL}/projects/{orderId}`, a route that loads the same existing order instead of creating a new one.

Check account model access before a real demo. No paid request runs in CI. The existing `pnpm verify:openai` checks server provider access; actual microphone/WebRTC acceptance still requires a Mac and working audio.

## Architecture and boundaries

```text
Electron main ─ typed, sender-checked preload ─ React overlay
                                                 ├─ commands/context → existing orchestrator
                                                 ├─ replayable SSE ← persisted MoleculeEvent
                                                 └─ WebRTC ↔ OpenAI (ephemeral authorization)
orchestrator → OpenAI adapter / reality / merchant agents / CP-SAT solver / Shopify
```

Main owns the frameless utility window, shortcuts, placement, permissions, explicit clipboard access, display-source authorization, notifications, tray, settings, and URL opening. The renderer has no Node access; it runs with context isolation and sandboxing. A restrictive CSP and origin checks protect IPC and the local backend. There is no generic filesystem, shell, IPC, or environment bridge.

The renderer store holds the current project, attachments, connection, event cursor, alerts, and recent activity. It refreshes authoritative snapshots after events and reconnects, ignores older revisions and results belonging to other projects, and never derives feasibility from model output.

The local backend store implements the existing session/event interfaces and adds context metadata and action receipts. It atomically replaces `state.json` with mode 0600 and retains context bytes in separate 0600 files. It is for **one local orchestrator process**, not a multi-process database. Backboard and Tiger adapters are not implemented here.

### API adaptation

Desktop calls use shared Zod schemas from `@molecule/contracts`:

| Endpoint                             | Purpose                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `GET /api/desktop/config`            | Demo flag, mock-provider disclosure, upload limit                        |
| `POST /api/projects`                 | Create an existing order session with `source: desktop` and an action ID |
| `GET /api/projects/:id`              | Authoritative snapshot plus attached assets                              |
| `POST /api/projects/:id/actions`     | Typed command, action ID, locale, time zone                              |
| `POST /api/projects/:id/context`     | Validated binary upload with name/type/action headers                    |
| `POST /api/desktop/realtime-session` | Project-scoped ephemeral Realtime authorization; no-store                |
| `GET /api/orders/:id/events`         | Existing SSE stream, `Last-Event-ID`, replay then `ready` marker         |
| `POST /api/chaos`                    | Existing backend supplier-offline recovery path, now retry-safe          |

The generic action endpoint replaces separate constraint/recompile/approval routes. Its bounded commands are `start_project`, `add_constraint`, `remove_constraint`, `attach_context`, `get_project_status`, `get_active_plan`, `explain_decision`, `request_recompile`, `approve_action`, `cancel_project`, and `open_command_center`. Status/plan/explanation tools return the same authoritative snapshot, including public quote and constraint explanations.

Realtime call IDs include a project-selection scope before mapping to `voice:{scopedCallId}`; transport retries retain action IDs and the originally observed revision. Switching projects clears voice history and replaces the scope so cached results cannot cross projects. The backend coalesces in-flight calls and persists receipts. Different arguments under one ID fail. A pending receipt surviving a server crash is an unknown outcome and is not executed again automatically: refresh first. This prevents blind duplication; it is not a claim of distributed transactional exactly-once delivery.

## Voice, context, and interruption

The backend configures the editable desktop instructions in `packages/openai/src/prompts/desktopVoice.ts`. The renderer sends SDP to OpenAI's current `/v1/realtime/calls` WebRTC endpoint using only the short-lived credential minted by `/v1/realtime/client_secrets`. Audio goes directly between the renderer and OpenAI.

Speech-start events, local microphone energy during playback, and the Interrupt control mute/pause local audio immediately, send `response.cancel`, and clear `output_audio_buffer`. Late output and undispatched tools from interrupted responses are ignored. Already-running backend work is reconciled through versioned corrections. A constraint spoken during the first compilation waits for the initial intent, then changes backend state and invokes the solver again.

Mute disables microphone tracks. Stop, hide, project switch, and lifecycle teardown close WebRTC, stop tracks, cancel retry timers, close the audio context, and release playback. Hiding does not cancel backend orchestration.

`voice-glow@0.2.0` runs on the existing React 19.3.0 runtime. `VoiceBeam` wraps `MoleculeInput` with exactly `level={() => yourLevel}` and no other props. The existing transmitted microphone stream feeds one analyser: RMS is normalized to `[0, 1]` and delivered through `RealtimeClient.subscribeLevel`, separately from the React state subscription. There is no second capture pipeline or assistant-output meter.

VoiceBeam's published defaults include breathing at zero. The input therefore hides its decorative layers through the package's documented opacity CSS variables when measured level is below 0.015; it does not generate artificial audio. VoiceBeam is unmounted when disconnected/closed, and respects reduced motion while connected. The analyser/source, animation frame, tracks, connection timers, WebRTC peer, and playback are released together. Short repeated connection failures exhaust the retry budget; it resets only after ten stable seconds.

Files: PNG, JPG/JPEG, PDF, CSV, TXT, JSON; 1 byte–10 MB each and at most eight per operation. The backend checks extension/MIME agreement and image/PDF signatures. XLSX is not supported because the existing backend has no parser. Explicit paste accepts text, files, or images; the clipboard is not polled.

Drop, file selection, paste-context, and screen capture stage removable files in the draft. Sending uploads and attaches them before submitting the instruction; sending context alone attaches it to the current project. Only confirmed attachments leave the staging area. Failed or uncertain files remain staged; an explicit retry retains the same action identity and reuses a confirmed upload receipt instead of uploading again. Pending backend receipts still require reconciliation. Switching projects clears the staged files and invalidates pending capture/upload results. Alerts and expansion never clear the draft.

Uploaded files pass through the OpenAI adapter and are included in subsequent compiler input. An attachment alone does not change product requirements: say or type “Put this on the hoodie.” For voice, send staged context before referring to it. Mock mode retains bytes/metadata but does not interpret image or document content.

“Share screen or window” explains the operation, lists sources, and authorizes one chosen source for 30 seconds. The renderer captures one frame, stops all display tracks, and stages the image for the same context API. It never starts continuous surveillance.

Official API references used:

- https://platform.openai.com/docs/guides/realtime-webrtc
- https://platform.openai.com/docs/api-reference/realtime-client-events/response/cancel
- https://platform.openai.com/docs/api-reference/realtime-client-events/output_audio_buffer/clear
- https://platform.openai.com/docs/guides/pdf-files
- https://www.electronjs.org/docs/latest/api/clipboard
- https://www.electronjs.org/docs/latest/api/session

Electron 44 uses asynchronous `clipboard.read()` / `ClipboardItem.getType()`, rather than the removed synchronous clipboard methods.

Electron 44.3 reports display capture to its permission handler as `media` with an empty `mediaTypes` array. That request is accepted only for the trusted main frame after explicit source selection; camera and mixed camera/microphone requests remain denied. The display handler consumes the selected source once.

## Recovery and notifications

The company view lays out actual plan edges in layers, including parallel suppliers. Selected nodes, quote statuses, failed merchants, costs, deadline, and feasibility all come from backend state/events.

The demo's “Take embroidery supplier offline” targets the selected TRANSFORM supplier and calls `/api/chaos`. Persisted offline events keep failed suppliers out of later candidate searches. Recovery emits failure, replanning, validation, and completion/approval events. It automatically executes only for an already-approved project with a certified replacement inside the current budget and deadline; increased cost without an explicit budget requires approval.

The UI prints the actual cost delta; it never hardcodes `+$18.40`. “No action required” appears only with backend `approvalRequired: false`. Unapproved plans require approval before mock Shopify execution and before automatic recovery.

Notifications are off until enabled in Settings. Hidden-overlay notifications are restricted to supplier failure, recovery, approval, unsatisfiable plans, and product readiness. Historical replay is silent. Clicking a notification shows its project. Auto-expand changes alert density without stealing focus from another app.

Main logs `notification.requested` when submitting a notice and `notification.shown` only after Electron emits `show`. A `notification.failed` record includes the native error. Submission alone does not establish delivery.

## Permissions and packaging

- **Microphone:** requested on the first voice action; denial links to the microphone privacy settings.
- **Screen Recording:** requested only from explicit screen sharing; denial links to Screen Recording settings. macOS may require an app restart after permission changes.
- **Notifications:** opt in through Settings and enable Molecule in macOS notification settings if needed.
- `Info.plist` supplies microphone/screen descriptions and the `molecule://project/{UUID}` protocol. Deep links wait for renderer readiness.
- Settings JSON lives in Electron's `userData` directory. Only non-secret preferences and the last project ID persist. Startup offers Resume; it never restarts a microphone or Realtime session.

```bash
pnpm --filter @molecule/desktop build
pnpm --filter @molecule/desktop start
pnpm --filter @molecule/desktop package:mac:local
```

For native notification acceptance, run `package:mac:local` **on a Mac**. It packages the host architecture under `apps/desktop/release/local/` and applies a complete ad-hoc signature with the `ai.molecule.desktop` bundle identity. It fails if signing fails. Launch the resulting app through Finder or Launch Services:

```bash
# Apple Silicon; use Molecule-darwin-x64 on Intel.
open apps/desktop/release/local/Molecule-darwin-arm64/Molecule.app
```

Enable notifications both in Molecule Settings and in **System Settings → Notifications → Molecule**. Electron's macOS notification API requires code signing; development Electron and the initial unsigned bundle failed native authorization on the test host. The ad-hoc build preserves the non-hardened development runtime and uses empty entitlements; it does not add private Apple entitlements or exemptions. A hardened-runtime ad-hoc experiment failed to launch because ad-hoc identities have no developer Team ID.

This is a local-development package, not a distribution profile. Production requires the team's Apple signing identity, appropriate hardened-runtime entitlements, notarization and distribution setup; those are not configured or certified. The local profile has not been certified for physical audio or all device permissions.

For unsigned bundles for both architectures:

```bash
pnpm --filter @molecule/desktop package:mac
```

`package:mac` alone does not provide usable native notification signing. Installer distribution and automatic updates are not configured.

## Overlay states

| State        | Appearance and behavior                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Hidden       | No dashboard/window; shortcut and tray remain active; server work continues                             |
| Compact      | Dark translucent pill, orb, microphone label, connection dot, voice bars                                |
| Conversation | Transcript/response, stop/mute/interrupt, text composer, attachment chips, filtered events              |
| Company      | Conversation plus compact branched graph, budget/deadline, constraints, approval/cancel, Command Center |
| Alert        | Supplier/plan/approval/recovery card with persisted facts and relevant action                           |

Controls are keyboard accessible, statuses include text, and animation respects reduced motion.

## Failure behavior

- Realtime: at most three reconnects (500 ms, 1 s, 2 s), fresh ephemeral credentials and refreshed backend snapshot each time. Then: **“Voice is unavailable. You can keep using text.”** Text and SSE remain available; retry voice explicitly.
- SSE: cursor-based reconnect with snapshot refresh and exponential backoff capped at 8 s; after eight consecutive failures, the UI offers Reconnect.
- HTTP: three transport attempts with the same mutation ID. Server validation errors are surfaced without automatic logical retries.
- Backend: **“Can’t reach Molecule right now.”**
- Microphone: **“Microphone access is off. Enable it in System Settings.”**
- Screen: **“Screen context requires Screen Recording permission.”**
- File: **“That file type isn’t supported yet.”**
- Clarification: unresolved customer details remain `NEEDS_CLARIFICATION` after constraint changes or recompile requests. The backend persists the questions and intent version without searching merchants or solving. The dock and voice expose those questions; supplying the details through `start_project` lets the compiler resolve them. Direct solver requests with ambiguity flags return the missing-detail explanations and no budget, deadline, or quantity relaxations.
- UNSAT: **“No valid company can satisfy all current requirements.”** Public solver explanations follow.
- Cancellation only stops planning before execution. It does not undo completed commerce.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm solver:lint
pnpm solver:test
pnpm --filter @molecule/desktop build
pnpm verify:desktop
pnpm verify:secrets
```

`verify:desktop` starts a real CP-SAT HTTP solver on an ephemeral local port, exercises the desktop API with mock providers, checks duplicate retries, context attachment, hard material correction, approved recovery, actual cost/deadline facts, and persistence after restart. It then exhausts the replacement supplier and verifies a persisted `UNSAT` plan, `NEEDS_HUMAN` state and `recovery.failed` event rather than a stale valid plan stuck in `SOLVING`. Absent solver response values are omitted to match the shared contract. Set `SOLVER_PYTHON` to an alternate Python environment if needed. It makes no paid calls and cleans up its temporary state.

Automated suites cover shortcut fallback/toggle, URL validation, event parsing/filtering/reconnect, stable tool IDs, mock WebRTC interruption/cleanup/retries, uploads and attachment commands, backend corrections/cancellation, durable receipts, supplier/recovery UI state, and material exclusion including unknown facts.

### Recorded Linux acceptance

Electron UI verification used the real durable backend and CP-SAT solver with disclosed provider mocks. The golden path was recorded at `d77b136`, with fixes and focused follow-up at `bbe1d85`.

| Area            | Observed result                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Overlay         | Hidden startup, fallback shortcut, compact/conversation/company/legible alert views                                |
| Text and events | Valid plan, live backend activity, logo follow-up, hard `material not_contains polyester` correction               |
| Context         | Native chooser, drag/drop PNG, clipboard image/text, explicit screen-frame upload; persisted bytes verified        |
| Execution       | Explicit approval before mock Shopify completion                                                                   |
| Recovery        | `stitch-works` → `thread-forge`; CAD 3300 → 3420, deadline preserved, approved recovery needed no further action   |
| Restart         | Settings persisted; startup offered Resume without voice; recovered plan and four attachments restored             |
| Command Center  | Correct existing project and recovered plan; no unrelated sample request in the composer                           |
| Notifications   | Hidden backend recovery ran; native delivery/click untested because the Linux notification service was unavailable |
| Voice           | Missing-device handling preserved text; physical microphone, live voice and barge-in remain untested               |

The earlier recording ends with a screen-permission error resolved and verified in the follow-up. Screen-permission denial guidance was not exercised after that fix. The fixture's selected merchants were cotton-compatible already, so their remaining selected after the polyester exclusion is expected; incompatible-candidate exclusion is covered by solver tests.

The workspace lint/typecheck/tests, solver Ruff/mypy/tests, desktop/web builds, client-secret scan and real-solver integration verification passed. GitHub reported no CI checks for the PR.

### Recorded macOS acceptance

The native run at `a2dda05` used macOS 26.5.2 (25F84), Apple Silicon, Node 24.20.0, pnpm 10.14.0, Python 3.12.11 and Electron 44.3.0. The orchestrator and CP-SAT solver were real; provider behavior was explicitly mocked.

| Area                | Observed result                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay             | Hidden launch; Option+Space; Escape; tray/settings; invalid shortcut fell back to Command+Shift+M; window moved on one display                                                                                    |
| Project             | VALID plan; logo upload/follow-up; hard no-polyester correction; explicit approval before mock commerce                                                                                                           |
| Recovery            | Hidden server work continued; `stitch-works` → `thread-forge`; CAD 3700 → 3820; deadline preserved; no further approval required                                                                                  |
| Context and restart | Explicit one-frame PNG capture; Quit/restart/Resume restored the project, attachments and preferences                                                                                                             |
| Links               | Correct Command Center project; packaged `molecule://project/{id}` opened the recovered project                                                                                                                   |
| Voice               | Unavailable microphone message preserved text; no audio input device or live OpenAI credentials                                                                                                                   |
| Notifications       | Development and initial unsigned package failed; a fully ad-hoc signed development copy delivered to Notification Center and actual click reopened the matching project after enabling app-specific notifications |
| Untested            | Physical/live voice and barge-in, active-audio stop-on-hide, OS permission-denial flows, multi-monitor, persisted window position, signing/notarization for distribution, live providers                          |

Mock parsing is deliberately limited. The tested deterministic request was:

> Need 200 premium onboarding kits with embroidered hoodie, under 7000 CAD by 2026-12-31.

The mock needs a supported quantity prefix, digits after `under`, explicit currency and an ISO deadline. For example, `200 premium onboarding kits under CAD 7000 ... December 31, 2026` produced clarification rather than a plan. Tote/mug interpretation and visual logo understanding were not certified by this mock run; natural-language voice acceptance requires the real compiler and Realtime.

For macOS mock testing, use `DEMO_MODE=true USE_MOCK_OPENAI=true` and an isolated writable `DATA_DIR` for the orchestrator, and `NEXT_PUBLIC_DEMO_MODE=true` for the web app. If `uv` was installed with the system Python's user pip, add its reported user-bin directory to `PATH`; on the test host it was `$HOME/Library/Python/3.9/bin`. The solver uses the separate Python 3.12 virtual environment.

The notification follow-up used the same `a2dda05` source in a separately signed copy. Strict deep signature verification passed; native logs confirmed matching bundle identifiers and successful delivery. The automatic authorization callback initially failed; delivery/click passed after the normal app-specific Settings toggle. A transient desktop banner was not separately certified. That follow-up also exposed the solver's null-versus-omitted completion mismatch when both suppliers were exhausted; the HTTP serialization and real-solver regression now cover that case.

The final focused run at `8045d6e` executed the committed `package:mac:local` command without manual re-signing. The resulting arm64 app passed strict deep signature verification, launched through Launch Services, and delivered native notifications with the existing app-specific permission. Actual Notification Center clicks opened the correct project after both successful recovery and exhausted-supplier failure. The latter returned HTTP 200, persisted `recovery.failed`, and displayed `UNSAT` / `NEEDS_HUMAN` with a public explanation and both failed suppliers; no stale valid plan remained. Native telemetry recorded six requests, six shown callbacks and no failures. This run used the real local solver/orchestrator and mocked providers.

Fresh notification authorization, transient desktop banners, physical/live voice and distribution signing remain unverified. An incidental microphone prompt was declined normally and text remained usable; this is not comprehensive permission-denial coverage.

The remaining native follow-up at `9585a17` reused the unchanged `8045d6e` package. Dragging the overlay persisted its origin `(212, 227)` through normal Quit/Launch Services restart; compact and expanded windows remained inside the single display's work area. With Molecule's OS microphone permission OFF, Talk showed the prescribed guidance and the Settings link worked. A text request still reached the backend and returned clarification. Disabling voice in app Settings also blocked Talk with enable-voice guidance.

The existing Screen Recording denied/restricted branch showed the permission explanation and Settings link, without enumerating sources or attaching a frame. A controlled deny/allow transition could not be tested: adding Molecule in System Settings required unavailable local account authorization. Permissions were left unchanged. The host reported zero CoreAudio devices and one Apple Virtual display, so physical audio and multiple-display behavior remain unverified.

### Live OpenAI voice acceptance

Actual Electron at `9585a17` connected through backend-minted ephemeral authorization (HTTP 200) to OpenAI WebRTC (HTTP 201), using the account-supported configured model `gpt-realtime-2.1`. `USE_MOCK_OPENAI=false` enabled the real compiler and Realtime adapter. Input was controlled synthetic speech through a Linux virtual microphone; the CP-SAT solver was real, while Reality, merchant quotes and Shopify remained mocked.

| Area                    | Observed result                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoken request          | Visible transcription and real `start_project`; authoritative intent retained 200 hoodies, CAD 7000 and December 31, 2026                                           |
| Correction              | Spoken “Actually absolutely no polyester” persisted intent v3 with hard `material not_contains polyester` and triggered solver evaluation                           |
| Interruption            | Playback paused/muted immediately; output buffer cleared and server truncation observed                                                                             |
| Generation cancellation | Returned `response_cancel_not_active` because generation had completed while audio was still playing; successful cancellation of active generation is not certified |
| Mute                    | UI and actual microphone track changed between disabled and enabled                                                                                                 |
| Disable voice           | Saving disabled voice while connected closed WebRTC, ended the microphone track and paused playback; preference persisted                                           |
| Hide                    | Hiding an active session closed WebRTC and ended its microphone track; reopening stayed idle                                                                        |
| Cleanup                 | Voice disabled; all three observed peers closed and microphone tracks ended                                                                                         |

**The full voice-to-valid-plan flow did not pass.** After clarification, project `56b9d740-9e4c-43dd-af57-5f191660f492` settled `NEEDS_HUMAN` with an `UNSAT` plan: “No quote-backed canonical candidate satisfies every required capability kind.” The live compiler emitted hard fields including quantity, color, size, delivery deadline, total cost and request scope. This branch's mock candidates expose only a material attribute, while the solver requires every hard field on every candidate. Global intent constraints and operation-specific requirements need alignment across compilation, canonical candidate facts and solver validation. No requirements were removed or supplier facts invented to obtain a passing result; no commerce was approved.

This verifies live voice transport, authoritative mutations and lifecycle cleanup with synthetic input. It does not certify physical macOS microphone/barge-in, active-generation cancellation, multimodal understanding, a live-compiled valid company or live commerce execution.

### Manual acceptance

On a Mac with account-supported OpenAI models and the missing real provider integrations connected:

1. Start solver/backend and desktop with no dashboard open. Press Option+Space.
2. Enable notifications in Settings. Start voice and grant microphone permission.
3. Say the 200-kit request, explicitly supplying currency and a reachable deadline if asked. Verify transcript, project, and intentional backend events.
4. Drop a real logo. Confirm its chip; say “Put this on the hoodie.”
5. While Molecule speaks, say “Actually, absolutely no polyester.” Confirm immediate audio stop, backend material exclusion, a new intent version, and solver recompilation. Only genuinely incompatible suppliers should disappear.
6. Inspect the valid plan and approve it. Confirm product readiness (marked mock in this checkout).
7. Hide the overlay; trigger the backend chaos endpoint against the active embroidery supplier from another terminal or the web app. Confirm a native notification, then click it.
8. Inspect the failed supplier, replacement, certified plan, actual delta, and preserved deadline. For an approved project within budget, confirm automatic recovery and “No action required.”
9. With voice actively engaged, repeat recovery if another supplier is available and confirm its short spoken summary. Voice intentionally stays stopped after hiding until explicitly resumed.
10. Open Command Center and confirm the URL and project match. Test a one-frame screen share separately, including denied permission.

The full physical microphone and live-provider acceptance flow remains open beyond the recorded checks above. Live OpenAI was exercised with a temporary server-side credential, but the compiler/candidate/solver contract mismatch prevented a valid plan. Real Shopify/Backboard/Tiger behavior requires integration work absent from the chosen base. A passing mock API/UI test is not a claim that those external systems were exercised.

## Integration packaging runtime (2026-09-19)

Use Node 22 for `pnpm --filter @molecule/desktop package:mac:local`, matching
CI. On this integration host, Node 26.5.1 exited with an unsettled top-level
await in Electron Packager; Node 22.23.1 produced the ad-hoc signed arm64 bundle
and `codesign --verify --deep --strict` passed. This is local packaging evidence,
not production distribution signing or notarization.
