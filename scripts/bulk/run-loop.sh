#!/usr/bin/env bash
# Keeps growing the demo data until the caps are reached. Safe to stop (Ctrl-C) and restart: every step resumes.
# Run from the repo root in your own terminal, e.g.  caffeinate -i scripts/bulk/run-loop.sh
#   TARGET_ROWS=10000000 PER_STORE=20000 INTERVAL=300 MAX_ROUNDS=0 scripts/bulk/run-loop.sh   (MAX_ROUNDS=0 = forever)
set -u
ENVF="--env-file=.env --env-file=.env.local"
TARGET_ROWS="${TARGET_ROWS:-5000000}"; PER_STORE="${PER_STORE:-10000}"; BATCH="${BATCH:-10000}"
INTERVAL="${INTERVAL:-300}"; MAX_ROUNDS="${MAX_ROUNDS:-0}"; round=0
while true; do
  round=$((round + 1)); echo "=== round $round $(date -u +%T)"
  node $ENVF scripts/bulk/bulk-load.mjs --replay --target-rows="$TARGET_ROWS" --max-seconds=600 --max-pass=8 || true
  node $ENVF scripts/bulk/shopify-catalog-fill.mjs --collect || true
  node $ENVF scripts/bulk/shopify-catalog-fill.mjs --bulk --batch="$BATCH" --per-store="$PER_STORE" || true
  node $ENVF scripts/bulk/bulk-load.mjs --compress --aggregates --max-seconds=600 || true
  [ "$MAX_ROUNDS" != "0" ] && [ "$round" -ge "$MAX_ROUNDS" ] && break
  sleep "$INTERVAL"
done
