# Local checkout versus main

Verified 2026-09-19 America/Toronto after fetching `origin/main`.

- Local `main`: `1317c972ab2eb6aa3def230282eea08141ad7260` (`more inventory stuff`).
- Remote `origin/main`: `2cf5398` (`Fix Tiger marketplace startup and desktop shortcut`).
- Local is one commit ahead and eight commits behind. It is not synchronized.
- An unfinished merge of `8675fe6` had seven unmerged files. `git merge --abort`
  succeeded and restored a clean pre-merge working tree before documentation edits.
- No local commit was discarded, reset or rebased; no merge was retried or pushed.

## Differences that matter

The unique local commit changes 25 files: reservations and catalog inventory,
Shopify transport retries, sync/environment handling, orchestrator inventory sync,
Reality reads, compiler/solver behavior, ROX action drafting and related tests.
These changes need deliberate review before reintegration; keeping them does not
certify that they pass acceptance.

The eight remote-only commits include verification/formatting and lockfile fixes,
Shopify CLI dependency, web reset/favicon/clarification improvements, environment
documentation cleanup, database seed typing, and the latest Tiger startup/desktop
shortcut fix. Merge ancestry also contains formatting and ROX scoring differences;
commit count is not an estimate of integration effort.

Conflicts were in catalog reservations and its test, the broad catalog fixture,
orchestrator workflow, Reality catalog gallery/inventory, and solver models.

## Recovery and next integration

A private backup was saved before abort:
`/private/tmp/molecule-merge-backup-20260919-203947`.
It contains changed tracked files, working/staged patches, index stages and refs.
It is temporary recovery material, not a durable project artifact. The preserved
local commit remains the primary record of pre-merge work.

Current edits after the abort are documentation only. The fresh starting point is
conflict-free local code, not a replacement with remote main. To adopt remote main
later, preserve the local commit on a branch, start a separate integration branch
from the fetched remote, and review/reapply the local changes in focused pieces.
Do not repeat a blind pull or hard-reset away the local work.
