# Molecule OS — Agent Instructions

## Read order

1. `docs/ARCHITECTURE.md`
2. `docs/CONTRACTS.md`
3. `docs/TASKS/<OWNER>.md`
4. Relevant tests before editing implementation

## Non-negotiable invariants

- Import domain schemas from `@molecule/contracts`. Do not redefine them.
- LLMs may interpret and propose; only `services/solver` can certify plan feasibility.
- All external provider calls go through adapters with mock equivalents.
- All external mutations require a `traceId` and deterministic `actionKey`/idempotency handling.
- Every meaningful state change emits a `MoleculeEvent` and is persisted.
- Unknown or conflicted merchant facts remain unknown or conflicted. Never guess operational truth.
- Never expose API keys in browser code or logs.
- Never log private model chain-of-thought. Log structured tool, validator, evidence, and decision events only.
- Do not edit another owner's provider package without explicit coordination.

## Before marking a task complete

- Run formatter, lint, and typecheck for the affected workspace.
- Run unit and integration tests for the affected module.
- Run the provider mock test.
- If credentials are available, run one sanitized real-provider smoke test.
- Update documentation when actual provider behavior differs from assumptions.

## Preferred implementation style

- Small pure functions around provider SDK calls.
- Explicit timeouts and typed errors.
- Runtime Zod/Pydantic validation at service boundaries.
- Deterministic test fixtures and seeded randomness.
- Minimal abstractions optimized for debuggability during the initial build.

## Design Context

### Users

Merchant operators and production teams use Molecule during focused daily work to describe outcomes, inspect evidence-backed plans, approve actions, and recover from operational change. Text remains a complete fallback; voice is an optional high-trust input mode.

### Brand Personality

Calm, precise, and quietly premium. The interface should feel responsive and alive without becoming theatrical, distracting, or vague about what is happening.

### Aesthetic Direction

Mac-oriented, restrained, and operational. Preserve the existing Molecule design system and dark Dock identity. Use one coherent voice signal rather than a generic AI orb, neon spectacle, or full-screen visualizer. Support intended narrow and desktop layouts, keyboard use, reduced motion, and WCAG AA behavior.

### Design Principles

- Make system state and microphone privacy unmistakable.
- Prefer real operational feedback over decorative motion.
- Distinguish listening, transcription, processing, speaking, and failure.
- Keep the primary request, Molecule’s work, and the confirmed result central.
- Preserve typed text and a fully usable text path through every voice failure.
