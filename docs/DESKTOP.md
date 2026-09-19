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

Settings and the menu-bar item provide alternate ways to open the overlay. Escape hides it. **Option+Shift+Space toggles conversation**; Electron `globalShortcut` does not provide reliable key-up events, so this is not hold-to-talk.

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

Realtime call IDs map to `voice:{callId}`; transport retries retain action IDs. The backend coalesces in-flight calls and persists receipts. Different arguments under one ID fail. A pending receipt surviving a server crash is an unknown outcome and is not executed again automatically: refresh first. This prevents blind duplication; it is not a claim of distributed transactional exactly-once delivery.

## Voice, context, and interruption

The backend configures the editable desktop instructions in `packages/openai/src/prompts/desktopVoice.ts`. The renderer sends SDP to OpenAI's current `/v1/realtime/calls` WebRTC endpoint using only the short-lived credential minted by `/v1/realtime/client_secrets`. Audio goes directly between the renderer and OpenAI.

Speech-start events, local microphone energy during playback, and the Interrupt control mute/pause local audio immediately, send `response.cancel`, and clear `output_audio_buffer`. Late output and undispatched tools from interrupted responses are ignored. Already-running backend work is reconciled through versioned corrections. A constraint spoken during the first compilation waits for the initial intent, then changes backend state and invokes the solver again.

Mute disables microphone tracks. Stop, hide, project switch, and lifecycle teardown close WebRTC, stop tracks, cancel retry timers, close the audio context, and release playback. Hiding does not cancel backend orchestration.

Files: PNG, JPG/JPEG, PDF, CSV, TXT, JSON; 1 byte–10 MB each and at most eight per operation. The backend checks extension/MIME agreement and image/PDF signatures. XLSX is not supported because the existing backend has no parser. Explicit paste accepts text, files, or images; the clipboard is not polled.

Uploaded files pass through the OpenAI adapter and are included in subsequent compiler input. An attachment alone does not change product requirements: say or type “Put this on the hoodie.” Mock mode retains bytes/metadata but does not interpret image or document content.

“Share current screen/window” explains the operation, lists sources, and authorizes one chosen source for 30 seconds. The renderer captures one frame, stops all display tracks, and uploads the image through the same context API. It never starts continuous surveillance.

Official API references used:

- https://platform.openai.com/docs/guides/realtime-webrtc
- https://platform.openai.com/docs/api-reference/realtime-client-events/response/cancel
- https://platform.openai.com/docs/api-reference/realtime-client-events/output_audio_buffer/clear
- https://platform.openai.com/docs/guides/pdf-files
- https://www.electronjs.org/docs/latest/api/clipboard
- https://www.electronjs.org/docs/latest/api/session

Electron 44 uses asynchronous `clipboard.read()` / `ClipboardItem.getType()`, rather than the removed synchronous clipboard methods.

## Recovery and notifications

The company view lays out actual plan edges in layers, including parallel suppliers. Selected nodes, quote statuses, failed merchants, costs, deadline, and feasibility all come from backend state/events.

The demo's “Take embroidery supplier offline” targets the selected TRANSFORM supplier and calls `/api/chaos`. Persisted offline events keep failed suppliers out of later candidate searches. Recovery emits failure, replanning, validation, and completion/approval events. It automatically executes only for an already-approved project with a certified replacement inside the current budget and deadline; increased cost without an explicit budget requires approval.

The UI prints the actual cost delta; it never hardcodes `+$18.40`. “No action required” appears only with backend `approvalRequired: false`. Unapproved plans require approval before mock Shopify execution and before automatic recovery.

Notifications are off until enabled in Settings. Hidden-overlay notifications are restricted to supplier failure, recovery, approval, unsatisfiable plans, and product readiness. Historical replay is silent. Clicking a notification shows its project. Auto-expand changes alert density without stealing focus from another app.

## Permissions and packaging

- **Microphone:** requested on the first voice action; denial links to the microphone privacy settings.
- **Screen Recording:** requested only from explicit screen sharing; denial links to Screen Recording settings. macOS may require an app restart after permission changes.
- **Notifications:** opt in through Settings and enable Molecule in macOS notification settings if needed.
- `Info.plist` supplies microphone/screen descriptions and the `molecule://project/{UUID}` protocol. Deep links wait for renderer readiness.
- Settings JSON lives in Electron's `userData` directory. Only non-secret preferences and the last project ID persist. Startup offers Resume; it never restarts a microphone or Realtime session.

```bash
pnpm --filter @molecule/desktop build
pnpm --filter @molecule/desktop start
pnpm --filter @molecule/desktop package:mac
```

`package:mac` produces Apple Silicon and Intel app bundles. Signing, notarization, installer distribution, and automatic updates are not configured. Use a local development build for acceptance; production distribution needs the team's Apple signing setup.

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

`verify:desktop` starts a real CP-SAT HTTP solver on an ephemeral local port, exercises the desktop API with mock providers, checks duplicate retries, context attachment, hard material correction, approved recovery, actual cost/deadline facts, and persistence after restart. Set `SOLVER_PYTHON` to an alternate Python environment if needed. It makes no paid calls and cleans up its temporary state.

Automated suites cover shortcut fallback/toggle, URL validation, event parsing/filtering/reconnect, stable tool IDs, mock WebRTC interruption/cleanup/retries, uploads and attachment commands, backend corrections/cancellation, durable receipts, supplier/recovery UI state, and material exclusion including unknown facts.

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

The full physical macOS/microphone/notification acceptance flow cannot be certified from a Linux machine. Live OpenAI and real Shopify/Backboard/Tiger behavior require credentials and implementations absent from the chosen base. A passing mock API/UI test is not a claim that those external systems were exercised.
