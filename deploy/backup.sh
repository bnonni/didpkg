#!/usr/bin/env bash
# Backs up the data of each DWN service (the SQLite files dwn.db and registration.db): dwn, and dwn2 if
# compose.dwn2.yaml is on. The file of a service is <service>-<time>.tar.gz. systemd/didpkg-dwn-backup.timer starts it each day.
# The script stops each dwn-server for some seconds, so that the copy of the database files is consistent.
# In that time, installs use the mirror (the DID document lists it after the DWN).
# Env: BACKUP_DIR (default /var/backups/didpkg-dwn), BACKUP_KEEP_DAYS (default 14).
set -euo pipefail
out=${BACKUP_DIR:-/var/backups/didpkg-dwn}
keep_days=${BACKUP_KEEP_DAYS:-14}
cd "$(dirname "$0")"
install -d -m 0700 "$out"
for svc in $(docker compose config --services | grep -x 'dwn[0-9]*'); do
  file="$out/$svc-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  docker compose stop "$svc"
  trap 'rm -f "$file.part"; docker compose start "$svc"' EXIT
  docker compose run --rm --no-deps -T --entrypoint tar "$svc" -czf - -C /app/data . > "$file.part"
  gzip -t "$file.part"
  mv "$file.part" "$file"
  trap - EXIT
  docker compose start "$svc"
  echo "$file"
done
find "$out" -maxdepth 1 -name 'dwn*-*.tar.gz' -mtime +"$keep_days" -delete
