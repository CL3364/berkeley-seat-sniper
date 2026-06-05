#!/bin/bash
# integration-gate.sh — the HEAVY gate. Run this at integration milestones
# (e.g. after a feature's lanes have all landed), NOT on every task completion.
# The lead invokes it before declaring a feature/app done.
# Exit nonzero on any failure so the lead/CI can block the merge.

set -e
echo "== integration-gate: whole-program typecheck =="
npx tsc --noEmit

echo "== integration-gate: unit + integration tests =="
npx vitest run

if [ -f playwright.config.ts ] || [ -f playwright.config.js ]; then
  echo "== integration-gate: end-to-end (Playwright) =="
  npx playwright test
else
  echo "integration-gate: no playwright config found — skipping E2E (add one to enable)."
fi

echo "== integration-gate: PASSED =="
