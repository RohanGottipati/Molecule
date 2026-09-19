# Desktop release handoff

Based on integration commit `11e822ed36796b1c91c77f01f7f147921cd3fe5e`.
Changes are limited to `apps/desktop/**`, `scripts/verify-desktop.mjs`, and this document.

## Implemented behavior

- Project selection cancels old reads/event subscriptions, stops voice, clears project activity, and ignores results from earlier selections. Backend revisions cannot move backward. Tool callers receive the newest confirmed snapshot.
- Identical pending UI actions coalesce. Retries preserve the action ID; reusing an explicit ID for different input fails. Pending counters and errors belong to the selected project.
- SSE reconnects from the last safe integer cursor, refreshes a confirmed snapshot before consuming events, cancels stalled readers, releases abandoned connections, and resets backoff after the replay/live boundary. Historical and duplicate events do not trigger notifications.
- Clipboard/screen acquisition and each upload step are tied to the original project. Context type, size, filename, and batch limits remain enforced. Display capture remains one selected source, one frame, no audio, with main-process authorization.
- IPC checks WebContents identity, main frame, and renderer origin. Service URLs require HTTPS or loopback HTTP without credentials, path, query, or fragment. Command Center links use the fixed configured origin and a UUID. Camera access is denied.
- Settings update in memory only after atomic persistence succeeds; changing a shortcut follows successful persistence. Shortcut fallback, tray access, notification de-duplication, and persisted window position remain available.
- Voice interruption suppresses stale output, playback completions, and tool continuations. Stopping during permission, capture, or negotiation cannot resurrect the session. Session grants use the project from the confirmed refresh. Reconnects release microphone tracks, audio contexts, peer/data-channel resources, playback, and timers.
- Provider details come from the canonical marketplace snapshot. Missing, malformed, or failed responses show unavailable status without disabling text actions. Graph layout preserves parallel branches and dependency order; it never certifies feasibility.

## Interfaces and wiring

No shared contract, IPC channel, package dependency, or existing HTTP endpoint changed.
Desktop-local interfaces added or extended:

| Module                                 | Interface                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main/policy.ts`                       | `serviceOrigin(value: string): string`; `rendererOrigin(value?: string): string`; `isTrustedFrame(value: string, origin: string): boolean`                                                                                                                                |
| `main/policy.ts`                       | `allowsIpcSender(sender: { id: number; mainFrame: boolean; url: string }, expectedId: number, origin: string): boolean`; `allowsMediaCheck(permission: string, mediaType: string \| undefined, selected: boolean): boolean`                                               |
| `renderer/services/molecule-api.ts`    | `MoleculeApi.marketplace(): Promise<MarketplaceSnapshot>`; `getProject(id: string, signal?: AbortSignal): Promise<DesktopResult>`                                                                                                                                         |
| `renderer/services/events.ts`          | `consumeEvents(stream: ReadableStream<Uint8Array>, onFrame: (frame: EventFrame) => void, signal?: AbortSignal): Promise<void>`; subscription `refresh(signal?: AbortSignal): Promise<void>`                                                                               |
| `renderer/state/desktop-store.ts`      | `DesktopState.marketplace: MarketplaceSnapshot \| null`; `providerError: string \| null`; `refreshProviders(): Promise<void>`; `refresh(signal?: AbortSignal): Promise<void>`; `uploadFrom(read: () => Promise<File[]>): Promise<void>`; `onProjectChanging?: () => void` |
| `renderer/state/desktop-store.ts`      | `command(command: DesktopCommand, actionId?: string): Promise<DesktopResult>` preserves explicit IDs and coalesces identical automatic actions                                                                                                                            |
| `renderer/services/realtime-client.ts` | `RealtimeDependencies.createSession(projectId: string): Promise<{ value: string }>`                                                                                                                                                                                       |

`GET /api/marketplace` is parsed with `MarketplaceSnapshotSchema` from
`@molecule/contracts`. Providers must report actual `mode`, `status`, and
`detail`; `generatedAt` is shown as the last update time. Refresh runs at
startup, every 60 seconds, and on demand. A missing endpoint is nonfatal.

Configuration remains main-process-only:

- `ORCHESTRATOR_URL`: default `http://localhost:3001`.
- `WEB_APP_URL`: default `http://localhost:3000`.
- `DESKTOP_RENDERER_URL`: development only, loopback origin; the runner uses
  `http://127.0.0.1:5173`. Packaged builds load `app://molecule`.
- Only ephemeral realtime grants reach the renderer. No long-lived provider
  credentials belong in desktop configuration.

API reads have a 15-second attempt timeout; mutations retain the 120-second
allowance and stable IDs across transport retries. Redirects are rejected.
Project switching suppresses old mutation results; it does not pretend to
roll back server work already accepted.

## Verification on Linux

Run from the repository root after the documented workspace/solver setup:

```sh
pnpm --filter @molecule/desktop lint
pnpm --filter @molecule/desktop typecheck
pnpm --filter @molecule/desktop test
pnpm --filter @molecule/desktop build
pnpm --filter @molecule/openai test
pnpm --filter @molecule/orchestrator test
pnpm verify:desktop
pnpm verify:secrets
```

All 66 desktop tests passed, covering URL/IPC/media policy, API errors, stale reads/actions,
duplicate actions, upload isolation, replay cancellation, settings persistence,
multi-branch graphs, and mocked realtime lifecycle/interruption. OpenAI's 30
tests and the orchestrator's 36 tests passed without paid provider calls.
Production main/preload/renderer bundling and the client-secret scan passed.
Prettier was applied only within the assigned scope.

The default `pnpm verify:desktop` is explicitly the **legacy hoodie smoke**
scenario. It passed with real Python CP-SAT and mock providers: create/upload
idempotency, context attachment, no-polyester correction, approval, embroidery
supplier failure/replacement, unchanged deadline/budget, actual HTTP SSE cursor
replay, idempotent cancellation, and restoration after backend restart.
Recovery added CAD 120.

Persistence uses the orchestrator's durable local store. This is not a
PostgreSQL/Tiger integration test.

The final kit acceptance path is separate and deliberately stricter:

```sh
DESKTOP_VERIFY_SCENARIO=kit pnpm verify:desktop
```

It requests 200 premium black onboarding kits by next Friday under CAD 7,000,
no leather, embroidered hoodie branding, named engraved bottles, vegan snacks,
individual packaging and fulfillment. It requires canonical
`hoodie`/`bottle`/`snacks` output IDs and a complete graph before continuing
through correction, approval, outage, and recovery checks.

## Parent integration requirements and acceptance gaps

The full kit scenario **fails on the assigned base**: the backend returns
hashed output IDs (`output-...`) instead of `hoodie`, `bottle`, and `snacks`.
Execution stops at that assertion; subsequent kit checks are not certified.
The legacy smoke must not serve as proof of the full release scenario.
After merging the parent-owned compiler/catalog/solver integration, run the
kit command above without weakening its assertions.

`GET /api/marketplace` returns 404 on the assigned base. The desktop handles
this truthfully; the parent must wire the canonical read model.
`GET /api/desktop/config` hardcodes `reality`, `merchants`, and `shopify`
mock flags to true. Derive these from actual adapter selection when wiring
live/demo providers. Preserve existing action/context/SSE contracts,
persisted action IDs, cursor replay, and the `ready` frame.

The production build was checked. The existing macOS packager targets arm64
and x64, uses ASAR for compiled main/preload/renderer output, and includes
microphone/screen usage strings plus the `molecule:` handler in `Info.plist`.
Packaging, signing/notarization, and native execution were not performed.

No browser UI testing was run, as assigned; the parent owns recorded acceptance.
Physical macOS hotkeys, notifications, privacy prompts, microphone devices,
audio playback, single-frame screen capture, and live WebRTC remain untested.
No real provider calls or credentials were used. Unit mocks and a Linux build
do not certify native/live behaviors.
