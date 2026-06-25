#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# ci-local.sh — Run the same checks as GitHub Actions CI locally.
#
# Usage:
#   ./scripts/ci-local.sh              # run all checks
#   ./scripts/ci-local.sh --contracts  # contracts only
#   ./scripts/ci-local.sh --frontend   # frontend only
#   ./scripts/ci-local.sh --scanner    # scanner only
#   ./scripts/ci-local.sh --circuits   # circuits only
#   ./scripts/ci-local.sh --supply     # supply chain only
# ------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RUN_ALL=true
RUN_CONTRACTS=false
RUN_FRONTEND=false
RUN_SCANNER=false
RUN_CIRCUITS=false
RUN_SUPPLY=false

for arg in "$@"; do
  case "$arg" in
    --contracts) RUN_CONTRACTS=true; RUN_ALL=false ;;
    --frontend)  RUN_FRONTEND=true;  RUN_ALL=false ;;
    --scanner)   RUN_SCANNER=true;   RUN_ALL=false ;;
    --circuits)  RUN_CIRCUITS=true;  RUN_ALL=false ;;
    --supply)    RUN_SUPPLY=true;    RUN_ALL=false ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

if $RUN_ALL; then
  RUN_CONTRACTS=true
  RUN_FRONTEND=true
  RUN_SCANNER=true
  RUN_CIRCUITS=true
  RUN_SUPPLY=true
fi

FAILED=0

check() {
  local name="$1"
  shift
  echo ""
  echo "================================================================="
  echo "  CHECK: $name"
  echo "================================================================="
  if "$@"; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name"
    FAILED=$((FAILED + 1))
  fi
}

# ----- gitleaks -----
check "Gitleaks secret detection" bash -c '
  which gitleaks >/dev/null 2>&1 || { echo "gitleaks not installed. Run: brew install gitleaks"; exit 1; }
  gitleaks protect --verbose --config .gitleaks.toml --staged 2>&1
'

# ----- Contracts (Rust) -----
if $RUN_CONTRACTS; then
  check "cargo fmt" cargo fmt --all -- --check
  check "cargo clippy" cargo clippy --workspace --all-targets -- -D warnings
  check "cargo test" cargo test --workspace --locked
fi

# ----- Scanner (WASM) -----
if $RUN_SCANNER; then
  check "build scanner" npm run build:scanner
  check "verify scanner manifest" npx tsx scripts/verify-artifact-manifest.ts --scanner --strict
fi

# ----- Circuits -----
if $RUN_CIRCUITS; then
  check "circuit regression tests" npm run test:circuits
fi

# ----- Frontend -----
if $RUN_FRONTEND; then
  check "frontend lint" bash -c 'cd frontend && npm ci && npm run lint'
  check "frontend typecheck" bash -c 'cd frontend && npx tsc -b --noEmit'
  check "frontend build" bash -c 'cd frontend && npm run build'
  check "frontend unit tests" bash -c 'cd frontend && npx vitest run'
fi

# ----- Supply chain & manifests -----
if $RUN_SUPPLY; then
  check "npm supply-chain audit" npm run audit:supply-chain
  check "verify deployment manifest" npm run verify:deployment
  check "cargo audit" bash -c 'which cargo-audit >/dev/null 2>&1 || { echo "cargo-audit not installed. Run: cargo install cargo-audit --locked"; exit 1; }; cargo audit'
  check "cargo deny" bash -c 'which cargo-deny >/dev/null 2>&1 || { echo "cargo-deny not installed. Run: cargo install cargo-deny --locked"; exit 1; }; cargo deny check'
fi

echo ""
echo "================================================================="
if [ "$FAILED" -eq 0 ]; then
  echo "  All checks passed!"
else
  echo "  $FAILED check(s) failed."
fi
echo "================================================================="
exit "$FAILED"
