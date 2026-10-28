#!/usr/bin/env bash
# Adds a publisher DID to the tenant allowlist of the demo DWN. Only a DID on the list can write.
# The admin API is not on the internet (traefik/dynamic.yml), so the request goes from the dwn container.
# Usage: deploy/tenant.sh <did>
set -euo pipefail
[[ $# -eq 1 && $1 =~ ^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$ ]] || { echo "usage: $0 <did>" >&2; exit 2; }
cd "$(dirname "$0")"
docker compose exec -T -e TENANT_DID="$1" dwn bun -e '
const r = await fetch("http://127.0.0.1:3000/admin/api/tenants", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.DWN_ADMIN_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ did: process.env.TENANT_DID }),
});
console.log(r.status, await r.text());
process.exit(r.status === 201 ? 0 : 1);'
