#!/bin/bash
# security-gate.sh — inline security checks. Run at milestones and in CI, not once a day.
# Secrets (gitleaks) + dependency audit (npm) + optional SAST (semgrep).
# Exit nonzero on findings so the merge is blocked.
#
# STRICT MODE: set SECURITY_GATE_STRICT=1 to FAIL when gitleaks or semgrep is
# missing, instead of silently skipping. For an app that holds subscriber PII +
# mail/push provider keys, run the gate strict in CI so secret-scan/SAST are not
# accidentally no-ops. (Locally it degrades gracefully so a team without the
# tools installed is not bricked.)

STATUS=0
STRICT="${SECURITY_GATE_STRICT:-0}"

missing() {  # $1 = tool name
  if [ "$STRICT" = "1" ]; then
    echo "security-gate: $1 not installed and SECURITY_GATE_STRICT=1 — FAILING. Install $1." >&2
    STATUS=1
  else
    echo "security-gate: $1 not installed — scan skipped. Install it to enable (or set SECURITY_GATE_STRICT=1 to fail)."
  fi
}

if command -v gitleaks >/dev/null 2>&1; then
  echo "== security-gate: secret scan — repository history (gitleaks) =="
  gitleaks git --no-banner --redact . || STATUS=1

  echo "== security-gate: secret scan — current build tree (gitleaks) =="
  # A history-only scan misses every uncommitted file. That is especially unsafe
  # during release verification, when Docker builds the working tree exactly as
  # it sits on disk. Archive Git's tracked + untracked/non-ignored file set, then
  # scan the archive so ignored local artifacts (.env, test output, browser
  # captures) neither create false positives nor hide source that will be added.
  GITLEAKS_TMP_DIR="$(mktemp -d)"
  GITLEAKS_ARCHIVE="$GITLEAKS_TMP_DIR/current-build-tree.tar"
  if git ls-files --cached --others --exclude-standard -z \
    | tar --null -T - -cf "$GITLEAKS_ARCHIVE"; then
    gitleaks dir --no-banner --redact --max-archive-depth 1 "$GITLEAKS_ARCHIVE" || STATUS=1
  else
    echo "security-gate: failed to assemble the current build tree for scanning." >&2
    STATUS=1
  fi
  rm -f "$GITLEAKS_ARCHIVE"
  rmdir "$GITLEAKS_TMP_DIR"
else
  missing gitleaks
fi

echo "== security-gate: dependency audit (npm) — shipped/production deps =="
# Release-block ONLY on advisories in dependencies we actually ship (production).
# devDependency advisories (e.g. the vite/vitest/esbuild dev-server file-read issues)
# never reach the deployed artifact and require running a local dev/UI server we do not
# run in CI or prod; they are surfaced below as informational + tracked, not blocking.
npm audit --omit=dev --audit-level=high || STATUS=1

echo "== security-gate: full dependency audit (informational; includes dev tooling) =="
npm audit --audit-level=high \
  || echo "security-gate: dev-tooling advisories present (non-shipping) — track & bump on next runner upgrade; NOT blocking the release."

if command -v semgrep >/dev/null 2>&1; then
  echo "== security-gate: SAST (semgrep) =="
  # Scan the same tracked + untracked/non-ignored source set that can enter a
  # release. Passing "." alone lets scanner/git-ignore interactions omit new
  # files before their first commit, which is exactly when this local gate is
  # most valuable.
  SEMGREP_PATHS_FILE="$(mktemp)"
  git ls-files --cached --others --exclude-standard -z -- \
    '*.cjs' '*.js' '*.jsx' '*.mjs' '*.ts' '*.tsx' >"$SEMGREP_PATHS_FILE"
  if [ -s "$SEMGREP_PATHS_FILE" ]; then
    xargs -0 semgrep --error --config auto -- <"$SEMGREP_PATHS_FILE" || STATUS=1
  else
    echo "security-gate: no source files found for Semgrep." >&2
    STATUS=1
  fi
  rm -f "$SEMGREP_PATHS_FILE"
else
  missing semgrep
fi

if [ "$STATUS" -ne 0 ]; then
  echo "== security-gate: FAILED — findings above must be resolved. ==" >&2
fi
exit "$STATUS"
