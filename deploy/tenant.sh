#!/usr/bin/env bash
# Manages the tenants of the demo DWN. A publisher adds its own DID with "didpkg id register" (proof of work and terms).
# The admin API is not on the internet (traefik/dynamic.yml), so the requests go from the dwn container.
# Usage: deploy/tenant.sh list
#        deploy/tenant.sh show|suspend|unsuspend|delete|purge|block <did>
#        deploy/tenant.sh quota <did> [<max bytes> <max messages> | default]
# show: the registration, the terms hash and the status. delete: the DID can register again; its records stay.
# purge: delete, and remove all records of the DID. block: purge, then keep the DID suspended, so it cannot register again.
# quota: 0 is no limit. "default" removes the quota of the DID, so the quota of compose.yaml applies.
set -euo pipefail
usage() { sed -n '4,6s/^# //p' "$0" >&2; exit 2; }
DID_RE='^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$'
case "${1:-} $#" in
  'list 1') ;;
  'show 2' | 'suspend 2' | 'unsuspend 2' | 'delete 2' | 'purge 2' | 'block 2' | 'quota 2') [[ $2 =~ $DID_RE ]] || usage ;;
  'quota 3') [[ $2 =~ $DID_RE && $3 == default ]] || usage ;;
  'quota 4') [[ $2 =~ $DID_RE && $3 =~ ^[0-9]+$ && $4 =~ ^[0-9]+$ ]] || usage ;;
  *) usage ;;
esac
cd "$(dirname "$0")"
docker compose exec -T -e CMD="$1" -e TENANT_DID="${2:-}" -e ARG3="${3:-}" -e ARG4="${4:-}" dwn bun -e '
const { CMD, TENANT_DID, ARG3, ARG4, DWN_ADMIN_TOKEN } = process.env;
const tenant = `/tenants/${encodeURIComponent(TENANT_DID)}`;
// One admin API request. Prints the JSON reply. A status that is not 2xx, and not in "allow", stops with exit 1.
const api = async (method, path, body, allow = []) => {
  const r = await fetch(`http://127.0.0.1:3000/admin/api${path}`, {
    method,
    headers: { authorization: `Bearer ${DWN_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok && !allow.includes(r.status)) {
    console.error(`${method} ${path}: HTTP ${r.status} ${text}`);
    process.exit(1);
  }
  return text;
};
switch (CMD) {
  case "list": {
    let cursor = "";
    do {
      const page = JSON.parse(await api("GET", `/tenants?limit=100${cursor && `&cursor=${encodeURIComponent(cursor)}`}`));
      for (const t of page.data) console.log(t.did, t.messageCount, t.dataStorageBytes);
      cursor = page.cursor ?? "";
    } while (cursor);
    break;
  }
  case "show": console.log(await api("GET", tenant)); break;
  case "suspend": console.log(await api("POST", `${tenant}/suspend`)); break;
  case "unsuspend": console.log(await api("POST", `${tenant}/unsuspend`)); break;
  case "delete": console.log(await api("DELETE", tenant)); break;
  case "purge": console.log(await api("DELETE", `${tenant}?purge=true`)); break;
  case "block":
    // 404: the DID has no registration and no records.
    console.log(await api("DELETE", `${tenant}?purge=true`, undefined, [404]));
    console.log(await api("POST", "/tenants", { did: TENANT_DID }));
    console.log(await api("POST", `${tenant}/suspend`));
    break;
  case "quota":
    if (ARG3 === "default") console.log(await api("DELETE", `${tenant}/quota`));
    else if (ARG3) console.log(await api("PUT", `${tenant}/quota`, { maxStorageBytes: Number(ARG3), maxMessages: Number(ARG4) }));
    console.log(await api("GET", `${tenant}/quota`));
    break;
}'
