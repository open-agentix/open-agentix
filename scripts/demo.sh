#!/usr/bin/env bash
# Seeds the local docker compose stack with the example agents and sends a signed webhook.
# Usage: scripts/demo.sh [http://localhost:8080]
set -euo pipefail
API="${1:-http://localhost:8080}"
SECRET="demo-webhook-secret"
json() { node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf8')))" "$1"; }

TOKEN=$(curl -fsS -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
  -d '{"username":"admin@example.com","password":"change-me-please-123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
H=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

curl -fsS -X POST "$API/v1/teams" "${H[@]}" -d '{"slug":"team-security","name":"Security"}' >/dev/null || true
for c in cve-db tickets; do
  curl -fsS -X POST "$API/v1/connections" "${H[@]}" -d "{\"name\":\"$c\",\"config\":{\"transport\":\"in-memory\"}}" >/dev/null || true
done
AGENT=$(curl -fsS -X POST "$API/v1/agents" "${H[@]}" -d "{\"source\":$(json examples/cve-triage.agents.md)}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -fsS -X POST "$API/v1/agents/$AGENT/publish" "${H[@]}" >/dev/null
SOURCE=$(curl -fsS -X POST "$API/v1/event-sources" "${H[@]}" \
  -d "{\"name\":\"trivy\",\"kind\":\"webhook\",\"secretRefs\":[\"demo-hook\"],\"agentId\":\"$AGENT\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

BODY=$(cat examples/events/trivy-finding.json)
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -fsS -X POST "$API/v1/ingest/webhook/$SOURCE" -H 'content-type: application/json' \
  -H "x-oax-timestamp: $TS" -H "x-oax-signature: v1=$SIG" --data "$BODY"
echo
echo "Follow the run: curl -N -H 'authorization: Bearer $TOKEN' $API/v1/runs/<runId>/stream"
