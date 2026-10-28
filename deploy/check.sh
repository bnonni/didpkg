#!/usr/bin/env bash
# Checks the public routes of a demo DWN: the didpkg routes pass, each other route gets 404.
# curl checks the TLS certificate. Usage: deploy/check.sh https://dwn.didpkg.dev
set -euo pipefail
base=${1:?usage: $0 <https url>}
fail=0
expect() { # <status> <method> <path>
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' -X "$2" --max-time 10 "$base$3") || true
  if [[ $got == "$1" ]]; then echo "ok   $2 $3 $got"; else echo "FAIL $2 $3 $got (expected $1)"; fail=1; fi
}
expect 200 GET /health
expect 200 GET /info
for path in / /admin /admin/api/tenants /metrics /registration /registration/proof-of-work /connect/par; do
  expect 404 GET "$path"
done
expect 404 POST /admin/api/tenants
expect 404 POST /registration
exit "$fail"
