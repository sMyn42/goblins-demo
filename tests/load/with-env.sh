#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${LOADTEST_ENV_FILE:-$SCRIPT_DIR/.env.test}"
if [[ "$ENV_FILE" != /* ]]; then ENV_FILE="$PWD/$ENV_FILE"; fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.test.example to .env.test and fill in isolated-test values." >&2
  exit 2
fi
chmod 600 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
STATE_DIR="${LOADTEST_STATE_DIR:-$SCRIPT_DIR/.state}"
if [[ -f "$STATE_DIR/base-url" ]]; then export LOADTEST_BASE_URL="$(<"$STATE_DIR/base-url")"; fi
if [[ -z "${LOADTEST_WORKER_MONITOR_TOKEN:-}" && -f "$STATE_DIR/monitor-token" ]]; then
  export LOADTEST_WORKER_MONITOR_TOKEN="$(<"$STATE_DIR/monitor-token")"
fi
if [[ -f "$STATE_DIR/active-run-id" ]]; then
  ACTIVE_RUN_ID="$(<"$STATE_DIR/active-run-id")"
  if [[ -n "${LOADTEST_RUN_ID:-}" && "$LOADTEST_RUN_ID" != "$ACTIVE_RUN_ID" ]]; then
    echo "LOADTEST_RUN_ID differs from the bootstrapped run ID in $STATE_DIR/active-run-id." >&2
    exit 2
  fi
  export LOADTEST_RUN_ID="$ACTIVE_RUN_ID"
elif [[ -z "${LOADTEST_RUN_ID:-}" ]]; then
  export LOADTEST_RUN_ID="preflight-$(date -u +%Y%m%dT%H%M%S)"
fi
if (( $# == 0 )); then echo "Usage: ./with-env.sh COMMAND [ARG ...]" >&2; exit 2; fi
cd "$ROOT"
exec "$@"
