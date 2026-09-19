---
name: molecule-linux-desktop-acceptance
description: Exercise Molecule's actual Electron dock, settings, screen picker and solver plan on Linux without live providers.
---

# Linux Electron UI acceptance

## Devin Secrets Needed

None for synthetic providers. Do not enable paid providers or physical-media claims.

## Setup

- Read the environment blueprint, docs/DESKTOP.md and browser-acceptance skill.
- Use its isolated PostgreSQL, synthetic provider safeguards and real CP-SAT setup.
- Build desktop before launch. In the Linux container, Electron may require `--no-sandbox`; use this only for the isolated container, not a production deployment.
- Launch `pnpm --filter @molecule/desktop exec electron . --no-sandbox --remote-debugging-port=9223 --user-data-dir=<isolated home directory>` with ORCHESTRATOR_URL and WEB_APP_URL pointing to the matching acceptance services.
- Keep CDP local and use it only for read-only diagnostics.
- Electron starts hidden. Ctrl+Shift+M is the Linux shortcut fallback. Click the M orb to expand/collapse.
- Backend status can be stale if the backend started after Electron; use its visible Refresh control before diagnosing connectivity.

## UI checks

- Settings is at the bottom of the scrollable conversation. Confirm unchanged Save is disabled.
- Change voice/notification preferences, save, reopen and verify persistence.
- Change a preference without saving; Escape should discard the draft and return focus to Settings. Enter should reopen it.
- Share screen/window must show an explicit picker. Escape should return focus to its trigger. Select only a synthetic local screen/window and verify a frame attachment or bounded actionable error.
- Without a microphone, Talk should produce actionable Settings guidance rather than a stuck recording state. Restore voice disabled afterward.
- For a valid company overlay, use a fresh or uncommitted dataset. A prior supplier outage and committed reservations can independently cause UNSAT; do not paraphrase the canonical brief to bypass that state.
- Submit the exact required brief with Ctrl+Enter, inspect the staged seven-node/six-link company, expand a node, and check budget/deadline.
- Escape hides the overlay; the global shortcut reopens it. Settings persist in the isolated profile across restart.
- Linux screen frames and missing-device errors do not certify native macOS permission dialogs, physical microphone/audio, or live-provider execution.
