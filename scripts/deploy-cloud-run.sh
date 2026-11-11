#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Loads the existing ignored env files; secret values are uploaded via stdin.
npm run deploy:cloud
