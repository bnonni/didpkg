#!/usr/bin/env bash
# Puts a backup.sh file back into the DWN data volume. The script deletes the current data first.
# The dwn container must exist: run "docker compose up -d" before you restore on a new VPS.
# Usage: deploy/restore.sh <dwn-*.tar.gz>
set -euo pipefail
[[ $# -eq 1 && -f $1 ]] || { echo "usage: $0 <dwn-*.tar.gz>" >&2; exit 2; }
backup=$(realpath "$1")
gzip -t "$backup"
cd "$(dirname "$0")"
docker compose stop dwn
trap 'docker compose start dwn' EXIT
docker compose run --rm --no-deps -T --entrypoint sh dwn -c 'find /app/data -mindepth 1 -delete && tar -xzf - -C /app/data' < "$backup"
