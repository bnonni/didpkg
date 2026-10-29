#!/usr/bin/env bash
# Checks the public routes of a demo DWN: the didpkg routes pass, each other route gets 404.
# A registration with no proof of work gets 400 from the dwn-server.
# curl checks the TLS certificate. Usage: deploy/check.sh https://dwn.didpkg.dev
set -euo pipefail
base=${1:?usage: $0 <https url>}
fail=0
expect() { # <status> <method> <path> [JSON body]
  local got body=()
  [[ $# -gt 3 ]] && body=(-H 'content-type: application/json' --data "$4")
  got=$(curl -s -o /dev/null -w '%{http_code}' -X "$2" "${body[@]}" --max-time 10 "$base$3") || true
  if [[ $got == "$1" ]]; then echo "ok   $2 $3 $got"; else echo "FAIL $2 $3 $got (expected $1)"; fail=1; fi
}
expect 200 GET /health
expect 200 GET /info
expect 200 GET /registration/terms-of-service
expect 200 GET /registration/proof-of-work
expect 400 POST /registration '{}'
for path in / /admin /admin/api/tenants /metrics /registration /connect/par; do
  expect 404 GET "$path"
done
expect 404 POST /admin/api/tenants
exit "$fail"
