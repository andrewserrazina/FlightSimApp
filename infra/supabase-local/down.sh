#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh
pkill -f "node gateway.mjs" 2>/dev/null || true
docker compose down -v
