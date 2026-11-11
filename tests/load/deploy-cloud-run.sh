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
if (( $# > 1 )); then echo "Usage: ./deploy-cloud-run.sh [--check|--deploy]" >&2; exit 2; fi
MODE="${1:---check}"
if [[ "$MODE" != "--check" && "$MODE" != "--deploy" ]]; then
  echo "Usage: ./deploy-cloud-run.sh [--check|--deploy]" >&2
  exit 2
fi

chmod 600 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
cd "$ROOT"
if [[ "$MODE" == "--deploy" ]]; then
  npm exec -- tsx tests/load/deploy-cloud-run.ts --deploy
else
  npm exec -- tsx tests/load/deploy-cloud-run.ts
fi
