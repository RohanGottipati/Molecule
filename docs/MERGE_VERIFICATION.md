# Final branch integration verification — 2026-09-19

All 14 remote branch tips below are incorporated through merge ancestry. PR #2
is the integration vehicle; PR #1's desktop work and PR #3's acceptance guide
are included. Source branches are retained. The original local Backboard checkout
and untracked TypeScript build metadata are untouched.

| Branch                                     | Reviewed tip | Disposition          |
| ------------------------------------------ | ------------ | -------------------- |
| `Backboard`                                | `cc93122`    | Included by ancestry |
| `Mac-OS-implementation`                    | `1ad571b`    | Included by ancestry |
| `devin/1789831103-final-integration`       | `8db0ca3`    | Included by ancestry |
| `devin/1789831413-backboard-release`       | `cf41aa9`    | Included by ancestry |
| `devin/1789831418-web-release`             | `4a1104f`    | Included by ancestry |
| `devin/1789831421-compiler-solver-release` | `39f1db4`    | Included by ancestry |
| `devin/1789831421-desktop-release`         | `33898c9`    | Included by ancestry |
| `devin/1789831425-shopify-release`         | `7e56eb8`    | Included by ancestry |
| `devin/1789831428-tiger-rox-release`       | `66cfa54`    | Included by ancestry |
| `devin/update-skills-1789836660`           | `963ff48`    | Included by ancestry |
| `main`                                     | `a59f7f7`    | Included by ancestry |
| `openai`                                   | `6987159`    | Included by ancestry |
| `shopify`                                  | `5189aa0`    | Included by ancestry |
| `tiger-rox`                                | `e274652`    | Included by ancestry |

## Compatibility and fixes

- Preserve durable Shopify execution at `@molecule/shopify`; preserve the incoming
  catalog/mock API at `@molecule/shopify/catalog`. The orchestrator continues to
  use durable execution. The catalog mock is a development fixture only.
- Share catalog fixtures with seed scripts, retaining both the broad catalog and
  integrated release catalog. Preserve all existing contract and fixture exports.
- Reject changed-input/cross-operation action-key reuse, isolate returned mock
  objects, validate inventory quantities, preserve unknown capacity, use synthetic
  invoice URLs, and restore deterministic state/identifiers on reset.
- Accept nullable live Backboard JSON-support metadata without claiming support
  when unknown. Keep runtime validation strict for malformed values.
- Retain historical desktop/provider acceptance limitations and distinguish
  unfinished Shopify roadmap work from the integrated release.

## Automated validation

Passed frozen pnpm installation, root formatting, lint, typecheck, all workspace
tests/builds, Python Ruff formatting/lint, mypy, all 62 solver tests, client-secret
scan, and `verify:desktop` / `verify:kit` using the real CP-SAT service.

The root run passed 440 TypeScript tests; its 53 database-dependent cases were
then covered with explicit disposable database settings. Across those runs all
493 TypeScript cases passed: contracts 13, desktop 70, Backboard 39, web 46,
DB 12, events 6, merchant agents 66, OpenAI 107, Shopify 61, Reality 33, and
orchestrator 40. Dedicated PostgreSQL runs skipped no tests. Durable acceptance
covers concurrency/revision rollback, stale and duplicate actions, reservation
release, restart, cursor replay, recovery and supplier exhaustion.

One Python subprocess exceeded the existing 20-second deadline on the first run
after dependency installation. The focused 107-test compiler suite and subsequent
full run passed without changing timeouts or assertions.

## Browser and native acceptance

Ran synthetic providers with a real CP-SAT solver and an isolated PostgreSQL 16
container; these are not live commerce results. The exact canonical comma-separated
brief produced seven nodes/six dependencies at CAD 6,395. Uploaded context, applied
`No polyester.`, preserved five hard constraints, approved seven supplier jobs,
and took Thread Forge offline. Needle North replacement cost CAD 6,515 (+120).

Stopped and restarted the actual orchestrator while keeping web/solver running.
The browser reconnected automatically using its last numeric SSE cursor, with
at most one active stream, and retained its completed receipt. This checks
persisted replay and cursor resume; it does not certify delivery of new events
created during downtime. A separate marketplace-fetch warning can require its
explicit Retry marketplace action even after the event stream reconnects.

Built the native arm64 package with Node 22.23.1 and verified its signature with
`codesign --verify --deep --strict`. On this Mac the packaged app passed hidden
startup, Alt+Space registration, activation, request, context upload, correction,
approval, supplier recovery, hide, quit/relaunch, project Resume, persisted context,
and the correct Command Center URL. The dashboard-link assertion intercepted
OS browser launching to check the exact existing-project destination.
Native automation used an isolated profile, disabled voice/notifications, and
closed the app afterward. Physical shortcut keystrokes, microphone, screen-capture
permission prompts, notification clicks, and production notarization were not
re-certified by this run. Node 26.5.1 packaging failed inside Electron Packager;
Node 22 is the verified packaging runtime.

## Credentialed checks and limits

- Shopify: read-only verification passed for all eight configured development
  stores, including store identity, currency and installed scopes. No live drafts,
  orders, inventory changes, payments or seeding were performed.
- Backboard: live model-list read returned 200 validated model entries after the
  nullable-capability fix. This does not certify paid conversations or memory writes.
- OpenAI: compilation smoke failed with HTTP 404 `model_not_found` for the default
  `gpt-5.6-terra` using the available credential. Set `OPENAI_COMPILER_MODEL` to an
  accessible API model before live compilation. Live voice and end-to-end external
  provider execution remain unverified. Keys and provider secrets were not logged.

Local logs, browser screenshots and native screenshots were retained outside the
repository in `/private/tmp/molecule-validation-20260919`. Temporary services,
browsers, the native app, the disposable database container and Docker Desktop
are shut down as part of completion. No deployment or production migration is
performed by this integration.
