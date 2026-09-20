# Contracts

`@molecule/contracts` is the canonical cross-service surface. Import its Zod schemas and inferred TypeScript types; do not recreate domain shapes in an application or service.

## Core domain values

- `ProductIntent`: versioned desired outputs, transformations, constraints, preferences, assets, and ambiguity flags.
- `MerchantCapability`: a merchant's typed supply, transform, assembly, or fulfillment capability.
- `CanonicalClaim`: a normalized claim with source, confidence, authority, and explicit resolution state.
- `QuoteResponse`: a validated accept, counteroffer, or decline response.
- `ProductionPlan`: a solver-produced graph with constraint results, cost, timing, and risk.
- `MoleculeEvent`: the persisted state-change envelope shared by services and the UI.

## Service endpoints

| Route                                   | Contract                                                | Rule                                                 |
| --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `POST /api/intents/compile`             | `CompileIntentRequest -> ProductIntent`                 | Strict schema output only                            |
| `POST /api/briefs/clarify`              | `BriefClarificationRequest -> BriefClarificationResult` | Preflight only; creates no project, asserts no facts |
| `POST /api/reality/ingest`              | source artifact -> `CanonicalClaim[]`                   | Preserve source and confidence                       |
| `POST /api/reality/resolve`             | merchant fields -> resolved fields                      | Conflicted/unknown are valid outcomes                |
| `POST /api/candidates/search`           | intent/capability need -> candidates                    | Search is candidate generation only                  |
| `POST /api/merchant-agents/:id/quote`   | `QuoteRequest -> QuoteResponse`                         | Live state comes from typed tools/canonical data     |
| `POST /api/merchant-agents/:id/reserve` | reservation request -> result                           | Transactional and idempotent                         |
| `POST /api/plans/solve`                 | `SolverInput -> ProductionPlan`                         | Only route allowed to declare `VALID`                |
| `POST /api/execution/commit`            | valid plan -> receipt                                   | Reject plans without solver validation               |
| `POST /api/chaos`                       | scenario -> event and receipt                           | Demo-only, authenticated, reversible                 |
| `GET /api/orders/:id/events`            | SSE `MoleculeEvent` stream                              | Backed by persisted rows                             |

### Brief clarification preflight

Before the web app creates a project it posts the draft to `POST /api/briefs/clarify`. The adapter runs the same `compileIntent` pass and translates `NEEDS_CLARIFICATION` flags into `ClarificationQuestion`s with optional `ClarificationOption`s:

- `CLEAR` — the brief compiles; the client proceeds with the existing `POST /api/orders` + message flow.
- `NEEDS_INPUT` — 1–8 questions, each with 0–6 suggested options. Quantity, deadline and currency choices are generated deterministically; other options come from a second structured model pass that may only propose choices, never facts (no invented quantities, dates, budgets, prices or availability). If that pass fails the questions still return with free-text input.
- `UNSUPPORTED` — reason only; the client must not submit.

Answers are appended to the customer's brief under a `Clarifications:` heading as `- Q: … A: …` lines (`composeClarifiedBrief` / `splitClarifiedBrief` in `@molecule/contracts`). The original text is never rewritten and the re-checked brief is what is finally sent as the first project message. The endpoint never certifies feasibility; the solver remains authoritative.

## Compatibility policy

- Additive optional fields may land without a version bump.
- Removing, renaming, or narrowing a field requires a coordinated versioned migration.
- Every boundary parses unknown input at runtime.
- Provider differences are translated in adapters and documented here; providers do not redefine the domain.
- JSON fixtures crossing into Python are parsed against a Pydantic mirror before solver execution.

The executable definitions live in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts).

## Shared project discovery, messages and action status

These are additive read envelopes. `OrderSessionSnapshotSchema` and successful
legacy mutation responses retain their existing strict shape. All routes below
are within the existing single-operator boundary; they do not add accounts or
tenant authorization.

| Route                              | Canonical response                  | Parameters                                                                                                                  |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`                | `ProjectListSchema`                 | `limit` 1–50 (default 20), `search` at most 100 characters (default empty), optional opaque `cursor` at most 512 characters |
| `GET /api/orders/:id/messages`     | `MessageHistorySchema`              | `afterCursor` nonnegative integer (default 0), `limit` 1–100 (default 50)                                                   |
| `GET /api/orders/:id/actions`      | `ActionStatusSchema`                | `key` 1–160 characters, `kind=message\|desktop\|approve\|upload` (default `message`)                                        |
| `GET /api/orders/:id/capabilities` | `ProjectCapabilitiesEnvelopeSchema` | No query parameters                                                                                                         |

Discovery returns `{ projects, nextCursor }`. Each project contains `orderId`,
`title`, `state`, `revision`, `createdAt`, and `updatedAt`. The title comes from
the current intent's desired output names, or “Untitled production project.”
Search matches the ID or title, case-insensitively, as literal text. Ordering is
immutable `createdAt` descending, then `orderId` ascending; updates do not move a
project between pages. Keep the same search when following a cursor, and start
from the first page to see newly created projects. Invalid query bounds or
cursors return a typed 400 error. Local, memory, and PostgreSQL repositories
implement `listProjects(query: ProjectListQuery): Promise<ProjectList>`.

### Original production messages

`MessageSubmissionSchema` describes `POST /api/orders/:id/messages`: existing
`text`, `locale`, `timeZone`, `assets`, `correction`, plus optional
`expectedRevision`. Send one stable `x-action-id` per submission and retain its
exact payload through uncertain transport outcomes. A replay with changed
arguments conflicts. A new request whose `expectedRevision` no longer matches
returns `409 ApiError { code: "STALE_VERSION", ... }` before acceptance.

Accepted input is persisted with the session transition in local/PostgreSQL
storage. The `productionMessage` event payload contains:

```ts
{
  messageId: string;
  orderId: string;
  source: "web" | "desktop" | "unknown";
  text: string;                  // exact supplied text, including whitespace
  assets: AssetRef[];            // actual refs passed to this compilation
  correction?: CompileIntentRequest["correction"];
  acceptedAt: string;
  acceptedRevision: number;
  planGeneration: number;
}
```

The history response is `{ messages, nextCursor }`. Entries add their event
`cursor` and `outcome: { messageId, status, resultRevision, reason }`, where status
is `pending | succeeded | failed | superseded | cancelled`. Outcomes are updated
from persisted `message.outcome` events. A successful workflow result can require
clarification or contain an UNSAT plan; it does not mean feasibility or execution
success. If a process stops before recording the outcome, it remains pending.
Reload from cursor zero to refresh outcomes on previously fetched entries;
`afterCursor` pages accepted messages, not later outcome changes.

No transcript is synthesized for legacy events. `DesktopActionSchema` now
accepts optional `originalText` and `expectedRevision`. Desktop `start_project`
compiles its existing `command.args.intent` while retaining `originalText` when
supplied (otherwise the exact intent argument). Typed desktop corrections retain
text only when `originalText` is supplied; absent original text is never invented.
They retain the assets already used by that intent. Newly attached context enters
a subsequent text compilation, not a typed constraint-only correction.

The common orchestration signatures are:

```ts
submitMessage(
  request: CompileIntentRequest,
  identity?: {
    messageId?: string;
    source?: "web" | "desktop" | "unknown";
    expectedRevision?: number;
    originalText?: string;
  },
): Promise<OrderSession>;

revise(
  orderId: string,
  command: Extract<DesktopCommand, {
    name: "add_constraint" | "remove_constraint" | "request_recompile";
  }>,
  actionId: string,
  originalText?: string,
  expectedRevision?: number,
): Promise<OrderSession>;
```

### Lost-response reconciliation

Action status returns only `{ orderId, key, kind, status, resultRevision,
resultState, error, automaticRetryAllowed: false }`. Status is
`unknown | pending | succeeded | failed | superseded`. `error` is a sanitized
`ApiError | null`; raw stored results, provider errors, and internal fingerprints
are excluded. `resultRevision` and `resultState` describe the recorded action
result, not necessarily the latest project. Fetch the current snapshot/history
after reconciliation. `succeeded` means the action returned a result; inspect
`resultState` and capabilities for clarification, UNSAT, cancellation, or
execution attention.

Public key mapping:

| `kind`    | `key`                                                                      |
| --------- | -------------------------------------------------------------------------- |
| `message` | Original web `x-action-id`                                                 |
| `desktop` | Original desktop `actionId`, including approvals/cancellations/attachments |
| `approve` | `${planId}:${intentVersion}` for web approval                              |
| `upload`  | Original context-upload `x-action-id`                                      |

Keys are scoped to the requested order. `unknown` means no receipt was found; it
does not prove that an interrupted request had no effects. Pending and failed
receipts survive restart and are never blindly retried. Global create actions
are not exposed through this order-scoped endpoint.

When a competing correction supersedes an accepted request, the losing request
returns `409 ApiError { code: "CONFLICT", ... }`, records a superseded outcome,
and cannot overwrite the winner. Revision guards do not merge concurrent edits.

### Capability and execution evidence

`deriveProjectCapabilities(snapshot, executionStarted = false)` returns
`{ canSubmitMessage, canCancelPlanning, canApprove, requiresOperator, reason }`.
`isPlanningState(state)` identifies states eligible for planning changes before
execution evidence is considered. The authoritative capabilities endpoint
additionally checks durable `execution.started` events; a snapshot-only client
must not infer absence of effects from a missing receipt.

`NEEDS_HUMAN`/`FAILED` with execution evidence prohibits planning cancellation and
correction. Known commerce receipts remain available when supplier acceptance
fails; unknown effects require operator reconciliation. Planning cancellation
fences late results and never promises commerce rollback. Recovery exceptions
persist a failed state and sanitized reason only for the current generation.
