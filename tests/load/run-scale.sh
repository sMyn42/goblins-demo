#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${LOADTEST_ENV_FILE:-$SCRIPT_DIR/.env.test}"
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$PWD/$ENV_FILE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy tests/load/.env.test.example to tests/load/.env.test and fill it with isolated-test values." >&2
  exit 2
fi

# .env.test is an explicitly sourced shell file, not an automatically loaded dotenv file.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
STATE_DIR="${LOADTEST_STATE_DIR:-$SCRIPT_DIR/.state}"
if [[ -f "$STATE_DIR/base-url" ]]; then
  export LOADTEST_BASE_URL="$(<"$STATE_DIR/base-url")"
fi
if [[ -z "${LOADTEST_WORKER_MONITOR_TOKEN:-}" && -f "$STATE_DIR/monitor-token" ]]; then
  export LOADTEST_WORKER_MONITOR_TOKEN="$(<"$STATE_DIR/monitor-token")"
fi
export LOADTEST_WORKER_CONCURRENCY="${LOADTEST_WORKER_CONCURRENCY:-2}"

if (( $# != 1 )); then
  echo "Usage: tests/load/run-scale.sh --setup|--xsmall|--small|--medium|--all" >&2
  exit 2
fi
MODE="$1"
case "$MODE" in
  --setup) COHORT="scale_50" ;;
  --xsmall) COHORT="scale_50" ;;
  --small) COHORT="scale_250" ;;
  --medium) COHORT="scale_1250" ;;
  --all) COHORT="scale_50" ;;
  *) echo "Unknown option: $MODE" >&2; echo "Use --setup, --xsmall, --small, --medium, or --all." >&2; exit 2 ;;
esac

PYTHON="$ROOT/.venv-load/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing .venv-load. Run: python3 -m venv .venv-load && .venv-load/bin/pip install -r tests/load/requirements.txt" >&2
  exit 2
fi
command -v gcloud >/dev/null || { echo "gcloud CLI is required." >&2; exit 2; }
cd "$ROOT"
chmod 600 "$ENV_FILE"

ACTIVE_RUN_FILE="$STATE_DIR/active-run-id"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [[ "$MODE" == "--setup" ]]; then
  if [[ -e "$ACTIVE_RUN_FILE" ]]; then
    echo "An active run ID already exists at $ACTIVE_RUN_FILE. Reuse it for its remaining cohorts; don't bootstrap again." >&2
    exit 2
  fi
  export LOADTEST_RUN_ID="${LOADTEST_RUN_ID:-run-$(date -u +%Y%m%dT%H%M%S)}"
  MANIFEST_PATH="${LOADTEST_MANIFEST_PATH:-$STATE_DIR/$LOADTEST_RUN_ID.json}"
  if [[ -e "$MANIFEST_PATH" ]]; then
    echo "Manifest already exists: $MANIFEST_PATH. Choose a fresh run ID and isolated assignment set." >&2
    exit 2
  fi
  echo "Running scale_50 preflight; no load or accounts are created yet."
  "$PYTHON" tests/load/run.py --preflight-only --cohort scale_50
  printf '%s\n' "$LOADTEST_RUN_ID" > "$ACTIVE_RUN_FILE"
  chmod 600 "$ACTIVE_RUN_FILE"
  echo "Preflight passed. Bootstrapping all 1,550 isolated synthetic accounts (about 16 minutes)."
  npm exec -- tsx tests/load/bootstrap.ts --run-id "$LOADTEST_RUN_ID"
  echo "Bootstrap complete. Reuse run ID $LOADTEST_RUN_ID for --xsmall, --small, and --medium."
  exit 0
fi

if [[ ! -f "$ACTIVE_RUN_FILE" ]]; then
  echo "No active bootstrapped run found. Run tests/load/run-scale.sh --setup first." >&2
  exit 2
fi
ACTIVE_RUN_ID="$(<"$ACTIVE_RUN_FILE")"
if [[ -n "${LOADTEST_RUN_ID:-}" && "$LOADTEST_RUN_ID" != "$ACTIVE_RUN_ID" ]]; then
  echo "LOADTEST_RUN_ID does not match the bootstrapped run ID in $ACTIVE_RUN_FILE." >&2
  exit 2
fi
export LOADTEST_RUN_ID="$ACTIVE_RUN_ID"
MANIFEST_PATH="${LOADTEST_MANIFEST_PATH:-$STATE_DIR/$LOADTEST_RUN_ID.json}"
if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Missing private session manifest: $MANIFEST_PATH. Do not bootstrap again blindly; investigate the setup run first." >&2
  exit 2
fi

echo "Running isolated $COHORT preflight."
"$PYTHON" tests/load/run.py --preflight-only --cohort "$COHORT"
if [[ "$MODE" == "--all" ]]; then
  echo "Running all three baseline scale cohorts; each also gets its own report."
  "$PYTHON" tests/load/run.py --plan scale
else
  echo "Running $COHORT only."
  "$PYTHON" tests/load/run.py --cohort "$COHORT"
fi
