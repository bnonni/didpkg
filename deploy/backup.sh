#!/usr/bin/env bash
# Backs up the DWN data (the SQLite files dwn.db and registration.db). systemd/didpkg-dwn-backup.timer starts it each day.
# The script stops the dwn-server for some seconds, so that the copy of the database files is consistent.
# In that time, installs use the mirror (the DID document lists it after the DWN).
# Env: BACKUP_DIR (default /var/backups/didpkg-dwn), BACKUP_KEEP_DAYS (default 14).
set -euo pipefail
out=${BACKUP_DIR:-/var/backups/didpkg-dwn}
keep_days=${BACKUP_KEEP_DAYS:-14}
cd "$(dirname "$0")"
install -d -m 0700 "$out"
file="$out/dwn-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose stop dwn
trap 'rm -f "$file.part"; docker compose start dwn' EXIT
docker compose run --rm --no-deps -T --entrypoint tar dwn -czf - -C /app/data . > "$file.part"
gzip -t "$file.part"
mv "$file.part" "$file"
find "$out" -maxdepth 1 -name 'dwn-*.tar.gz' -mtime +"$keep_days" -delete
echo "$file"
