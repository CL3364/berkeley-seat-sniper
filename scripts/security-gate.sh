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
  echo "== security-gate: secret scan (gitleaks) =="
  gitleaks detect --no-banner --redact || STATUS=1
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
  semgrep --error --config auto . || STATUS=1
else
  missing semgrep
fi

if [ "$STATUS" -ne 0 ]; then
  echo "== security-gate: FAILED — findings above must be resolved. ==" >&2
fi
exit "$STATUS"
