#!/usr/bin/env bash
# Puts a backup.sh file back into the data volume of its DWN service: a dwn-*.tar.gz file into dwn, a dwn2-*.tar.gz file
# into dwn2. The script deletes the current data first.
# The container must exist: run "docker compose up -d" before you restore on a new VPS.
# Usage: deploy/restore.sh <dwn-*.tar.gz | dwn2-*.tar.gz>
set -euo pipefail
[[ $# -eq 1 && -f $1 ]] || { echo "usage: $0 <dwn-*.tar.gz | dwn2-*.tar.gz>" >&2; exit 2; }
backup=$(realpath "$1")
svc=$(basename "$backup")
svc=${svc%%-*}
gzip -t "$backup"
cd "$(dirname "$0")"
# No grep -q: with pipefail, an early exit of grep can fail the pipe.
if ! [[ $svc =~ ^dwn[0-9]*$ ]] || ! docker compose config --services | grep -x "$svc" > /dev/null; then
  echo "$0: the file name must start with the name of a DWN service, for example dwn-" >&2
  exit 2
fi
docker compose stop "$svc"
trap 'docker compose start "$svc"' EXIT
docker compose run --rm --no-deps -T --entrypoint sh "$svc" -c 'find /app/data -mindepth 1 -delete && tar -xzf - -C /app/data' < "$backup"
