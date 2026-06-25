#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY="$REPO_ROOT/deployments/security/npm-audit-policy.jsonc"

if [[ ! -f "$POLICY" ]]; then
  echo "Missing npm audit policy: $POLICY" >&2
  exit 1
fi

audit_lockfile() {
  local dir="$1"
  local lockfile="$dir/package-lock.json"
  local label="${dir#$REPO_ROOT/}"
  if [[ "$label" == "$dir" ]]; then
    label="."
  fi

  if [[ ! -f "$lockfile" ]]; then
    echo "Skip: no package-lock.json in $label"
    return 0
  fi

  echo ""
  echo "================================================================="
  echo "  npm audit (production): $label"
  echo "================================================================="
  (
    cd "$dir"
    npx audit-ci --config "$POLICY"
  )
}

audit_lockfile "$REPO_ROOT"
audit_lockfile "$REPO_ROOT/frontend"

echo ""
echo "npm supply-chain audit passed"
