#!/bin/bash
# fast-gate.sh — TaskCompleted hook. Runs ONLY cheap, lane-scoped checks on the
# files that actually changed. Deliberately does NOT run a whole-program typecheck
# or the full test suite — those run at the integration milestone (integration-gate.sh).
# This avoids the classic deadlock where one teammate's completed task is blocked by
# half-built code it does not own.
# Exit 0 = allow completion. Exit 2 = block completion + send reason to the agent.

INPUT=$(cat)  # consume stdin

# Collect changed + staged + untracked files (porcelain is stable across git versions).
CHANGED=$(git status --porcelain 2>/dev/null | sed -E 's/^.{3}//' | sed -E 's/^.* -> //')

# Prettier owns more than JS/TS. Keep its common repo formats separate from the
# ESLint set so a changed Markdown/YAML/JSON file cannot pass locally and then
# fail CI's repo-wide format check.
FORMAT_FILES=$(printf '%s\n' "$CHANGED" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|markdown|ya?ml|css|scss|less|html)$' || true)
LINT_FILES=$(printf '%s\n' "$CHANGED" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' || true)

# No supported source or document changed → nothing to gate.
[ -z "$FORMAT_FILES" ] && [ -z "$LINT_FILES" ] && {
  echo "fast-gate: no supported files changed." >&2
  exit 0
}

fail() { echo "fast-gate FAILED: $1. Fix the listed files before completing this task." >&2; exit 2; }

# Format check (changed files only).
if command -v npx >/dev/null 2>&1 && [ -f node_modules/.bin/prettier ]; then
  if [ -n "$FORMAT_FILES" ]; then
    printf '%s\n' "$FORMAT_FILES" | xargs npx prettier --check >/dev/null 2>&1 || fail "formatting (prettier) on changed files"
  fi
fi

# Lint changed files only — never the whole repo, so pre-existing warnings elsewhere don't block you.
if command -v npx >/dev/null 2>&1 && [ -f node_modules/.bin/eslint ]; then
  if [ -n "$LINT_FILES" ]; then
    printf '%s\n' "$LINT_FILES" | xargs npx eslint --max-warnings=0 >/dev/null 2>&1 || fail "lint (eslint) on changed files"
  fi
fi

echo "fast-gate passed on changed files." >&2
exit 0
