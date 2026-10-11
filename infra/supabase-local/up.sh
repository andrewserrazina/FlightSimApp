#!/bin/bash
# Start the local test stack, apply the cloud migrations, start the gateway.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh
docker compose up -d --wait db
docker compose up -d auth rest mail
echo "waiting for auth migrations…"
for i in $(seq 1 90); do curl -sf http://127.0.0.1:54325/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:54325/health >/dev/null || { echo "auth did not become healthy"; docker compose logs auth | tail -20; exit 1; }
for f in ../../db/migrations/*.sql; do
  echo "applying $(basename "$f")"
  PGPASSWORD="$SB_LOCAL_DB_PASSWORD" psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 54322 -U postgres -d postgres -f "$f"
done
# Reload PostgREST's schema cache after migrations.
docker compose kill -s SIGUSR1 rest >/dev/null
if ! curl -sf -o /dev/null http://127.0.0.1:54321/templates/confirmation.html; then
  nohup node gateway.mjs > gateway.log 2>&1 &
  sleep 1
fi
echo "local Supabase stack ready at http://127.0.0.1:54321 (mail UI http://127.0.0.1:54327)"
