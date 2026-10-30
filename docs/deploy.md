# Runbook: the demo DWN on a VPS

This runbook puts the demo DWN `dwn.didpkg.dev` on one VPS. The files are in `deploy/`.

## What runs

| Part | Version | Task |
|---|---|---|
| `dwn` | `@enbox/dwn-server` 0.1.45 on Bun 1.4.4 (`deploy/dwn/`, built on the VPS) | The DWN, with registration (terms of service and proof of work) and a quota for each tenant. Its port is not published. |
| `traefik` | Traefik v3.7.16 | TLS from Let's Encrypt (TLS-ALPN challenge), the route allowlist, the limits. |
| `didpkg-dwn-backup.timer` | systemd on the host | One backup each day at 03:30 UTC (plus a random delay of up to 15 min). |

Rules of the stack:

1. Only TCP port 443 is open to the internet. Port 80 is not used.
2. Only the routes of didpkg pass: `GET /health`, `GET /info`, `POST /`, `GET /<did>/query...` and `GET /<did>/read/...`. The registration routes pass too: `GET /registration/terms-of-service`, `GET /registration/proof-of-work` and `POST /registration`. Each other request gets 404, for example `/admin`, `/metrics` and `/connect`.
3. Only a registered DID can write, and the DWN gives only the records of a registered DID. A DID registers itself with `didpkg id register`. It accepts the terms of service (`deploy/terms-of-service.txt`) and does a proof of work (about 30 s). There is no provider auth. The registration does not prove control of the DID, but the DWN checks each write against the DID document.
4. Traefik allows 20 requests a second for each client IP, with a burst of 50. The dwn-server sees only the Traefik address, so its own limits are off.
5. A request body can be 17 MiB at most. A DWN record can be 16 MiB at most.
6. The data is in the Docker volume `didpkg-dwn_dwn-sqlite`, in 2 SQLite files: `dwn.db` (the DWN records) and `registration.db` (the tenants and the quotas). The certificate is in `didpkg-dwn_acme`.
7. Each tenant can store 50 MiB of record data and 10,000 DWN messages. A write over the quota fails with HTTP 500 and `TenantStorageQuotaExceeded` or `TenantMessageQuotaExceeded`.

The only secret is `deploy/.env` (the admin token). The DWN data and the backups hold only public data: packages and tenant DIDs.

## 1. Before you start (you, about 20 min)

1. Rent a VPS with a public IPv4 address: 1 vCPU, 1 GB RAM or more (2 GB gives a margin), 20 GB disk, Ubuntu 24.04 LTS or Debian 13.
2. At Namecheap, add the DNS record `A dwn.didpkg.dev <VPS IPv4>` with TTL 300. If the VPS has IPv6, add the `AAAA` record too.
3. Make sure that the name resolves: `dig +short dwn.didpkg.dev` must show the VPS address.

## 2. Install (on the VPS as root, about 15 min)

1. Install Docker Engine and the Compose plugin from the Docker apt repository: https://docs.docker.com/engine/install/ubuntu/ (or `/debian/`).
2. Make sure that `docker compose version` shows 2.24 or later.
3. Open only SSH and port 443:

   ```sh
   ufw allow OpenSSH && ufw allow 443/tcp && ufw enable
   ```

4. Get the repository. Use the commit of `main` that you signed:

   ```sh
   git clone https://github.com/bnonni/didpkg /opt/didpkg
   git -C /opt/didpkg checkout <commit>
   ```

5. Make `deploy/.env` with mode 0600, then set the token and your email:

   ```sh
   cd /opt/didpkg/deploy
   install -m 0600 .env.example .env
   sed -i "s/^DWN_ADMIN_TOKEN=.*/DWN_ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
   sed -i "s/^ACME_EMAIL=.*/ACME_EMAIL=<your email>/" .env
   ```

6. Start the stack. The first start builds the image (about 1 min):

   ```sh
   docker compose up -d --build --wait
   ```

7. Turn on the daily backup, then run it one time:

   ```sh
   install -m 0644 systemd/didpkg-dwn-backup.service systemd/didpkg-dwn-backup.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now didpkg-dwn-backup.timer
   systemctl start didpkg-dwn-backup.service && ls -l /var/backups/didpkg-dwn/
   ```

## 3. Check (on your machine, 1 min)

Run the route check. The first certificate can take up to 1 min after the start.

```sh
deploy/check.sh https://dwn.didpkg.dev
```

Each line must start with `ok`. curl checks the certificate, so a pass also proves TLS. The stack test (`bun deploy/test/stack.ts`) proves the rest of the stack locally, but not Let's Encrypt.

## 4. Check with a publisher (about 10 min)

A publisher needs no action from you: each publisher registers its own DID (see [Publish a package](publish.md)). To check the DWN, do these steps as a publisher.

1. On your machine, make the identity with this DWN in its `#dwn` service:

   ```sh
   didpkg id create main --dwn https://dwn.didpkg.dev --repo https://<user>.github.io/<repo>/
   didpkg id create web --web <user>.github.io:<repo> --dwn https://dwn.didpkg.dev --repo https://<user>.github.io/<repo>/web/
   ```

   A did:dht identity goes to the default relays, `relay.pkarr.org` too. The DWN resolves did:dht through `relay.pkarr.org`. A did:web identity needs its `did.json` on the site before step 3.

   Each publisher must have its own mirror URL, because the mirror path has no DID in it. Here, `web/` is the mirror of the second publisher. If two publishers use one URL, the second publish of the same version fails with `a different file exists`.

   The did:dht DID is not registered yet, so `id create main` shows the next command, `didpkg id register <alias>`. The publish in step 3 installs the protocol.
2. Register each DID. Read the terms, then type `y`. The proof of work takes about 30 s on average:

   ```sh
   didpkg id register main
   didpkg id register web
   ```

3. On your machine, publish:

   ```sh
   didpkg publish main <tarball> --to dwn --to dir:<site folder>
   didpkg publish web <tarball> --to dwn --to dir:<site folder>/web
   ```

4. Push the site. Then, on your machine, install each name with npm, pnpm and bun through the shim. The script must print `PASS`:

   ```sh
   bun demo/live.ts <install-name>...
   ```

   To check the mirror fallback, run `docker compose stop dwn` on the VPS, then `bun demo/live.ts --dwn-down <install-name>...`, then `docker compose start dwn`.

## Operate

| Task | Command (on the VPS, in `/opt/didpkg/deploy`) |
|---|---|
| See the logs | `docker compose logs --tail 100 dwn` (or `traefik`) |
| See the state | `docker compose ps` |
| Restart | `docker compose restart` |
| Update to a new commit | `git -C /opt/didpkg fetch && git -C /opt/didpkg checkout <commit> && docker compose up -d --build --force-recreate --wait` |
| Change the admin token | Edit `.env`, then `docker compose up -d --wait` |
| Restore a backup | `./restore.sh /var/backups/didpkg-dwn/dwn-<time>.tar.gz` |
| See the backup timer | `systemctl list-timers didpkg-dwn-backup.timer` |

An update must make new containers (`--force-recreate`). The stack mounts single files, for example `traefik/dynamic.yml`. A checkout replaces each changed file, but a container that runs continues to read the old file. Example: after the move to SQLite, Traefik gave 404 for `/registration` until a new Traefik container started.

To restore on a new VPS, do sections 1 and 2 first, copy the backup file to the VPS, then run `restore.sh`. The backup holds the registrations too.

Keep a copy of the backups off the VPS. For example, run this command on your machine each week:

```sh
rsync -a root@<vps>:/var/backups/didpkg-dwn/ ~/backups/didpkg-dwn/
```

## Manage the tenants

Use `deploy/tenant.sh` on the VPS, in `/opt/didpkg/deploy`. It sends each request to the admin API from the dwn container.

| Task | Command |
|---|---|
| List the tenants, with the message count and the bytes of each tenant | `./tenant.sh list` |
| Show the registration, the terms hash and the status of a DID | `./tenant.sh show <did>` |
| Stop the writes of a DID and the reads of its records | `./tenant.sh suspend <did>` |
| Allow a suspended DID again | `./tenant.sh unsuspend <did>` |
| Remove the registration of a DID. Its records stay, and it can register again | `./tenant.sh delete <did>` |
| Remove the registration and all records of a DID | `./tenant.sh purge <did>` |
| Remove all records of a DID, and keep the DID suspended | `./tenant.sh block <did>` |
| Show the quota and the usage of a DID | `./tenant.sh quota <did>` |
| Set the quota of a DID (0 is no limit) | `./tenant.sh quota <did> <max bytes> <max messages>` |
| Give a DID the quota of `compose.yaml` again | `./tenant.sh quota <did> default` |

For abuse, use `block`. A new registration does not clear a suspension, but `delete` and `purge` remove the suspension.

## Change the terms of service

A change of the terms stops each tenant. Until a publisher registers again, the DWN refuses its writes and the reads of its records: `401 Agreed terms-of-service is outdated`. In that time, installs use the mirrors.

1. Edit `deploy/terms-of-service.txt`, commit the change, and sign the commit.
2. On the VPS, check out the commit. Then make a new dwn container, because the server reads the terms only when it starts:

   ```sh
   git -C /opt/didpkg fetch && git -C /opt/didpkg checkout <commit> && docker compose up -d --build --force-recreate --wait dwn
   ```

3. Tell the publishers to run `didpkg id register <alias>` again, for example in a GitHub issue. Register the demo DIDs again too.

## Change the pinned dwn-server

To change the pinned `dwn-server`, edit `deploy/dwn/package.json`, then run `bun install --lockfile-only --ignore-scripts` in `deploy/dwn/`. Use the same versions as the root `bun.lock`, so the DWN runs the code that the tests use. Then run `bun deploy/test/stack.ts` before you commit.

## Move from LevelDB to SQLite (one time, about 20 min)

The first stack kept the DWN records in LevelDB, in the volume `didpkg-dwn_dwn-data`. LevelDB has no admin store, so it has no quotas. The stack now uses SQLite in the new volume `didpkg-dwn_dwn-sqlite`. There is no data conversion: each publisher registers again and publishes each package again. The old volume stays, so you can go back.

On the VPS, in `/opt/didpkg/deploy`, before you check out the new commit:

1. Make a backup:

   ```sh
   ./backup.sh
   ```

2. On your machine, copy the backup off the VPS:

   ```sh
   rsync -a root@<vps>:/var/backups/didpkg-dwn/ ~/backups/didpkg-dwn/
   ```

3. Write down the tenant DIDs. The admin API cannot list the tenants with LevelDB, so the command reads the allowlist file:

   ```sh
   docker compose exec -T dwn bun -e 'import { Database } from "bun:sqlite"; for (const t of new Database("data/registration.db", { readonly: true }).query("SELECT did FROM registeredTenants").all()) console.log(t.did)'
   ```

4. Check out the new commit and start the stack with new containers. The DWN starts with no data:

   ```sh
   git -C /opt/didpkg fetch && git -C /opt/didpkg checkout <commit> && docker compose up -d --build --force-recreate --wait
   ```

5. Tell the publisher of each DID of step 3 to register again with `didpkg id register <alias>`, then to publish again.

On your machine, in the didpkg repository:

1. Run `deploy/check.sh https://dwn.didpkg.dev`. Each line must start with `ok`.
2. Register each demo DID again: `didpkg id register <alias>`.
3. Publish each version of each package again, to the DWN and to its mirror clone. The tarball is in the mirror clone:

   ```sh
   didpkg publish <alias> <site folder>/<name>/<version>.tgz --to dwn --to dir:<site folder>
   ```

   The publish finds the signed release and index on the mirror and writes the same bytes to the DWN. The mirror files do not change, so `git status` in the clone must show no change.
4. Install each name through the shim. The script must print `PASS`:

   ```sh
   bun demo/live.ts <install-name>...
   ```

5. After 7 days with no problem, delete the old volume on the VPS: `docker volume rm didpkg-dwn_dwn-data`.

To go back before step 5, check out the old commit on the VPS and run `docker compose up -d --build --force-recreate --wait`. The stack then uses the old volume.

## Known limits

1. The backup stops the dwn-server for some seconds each day, so that the copy of the database files is consistent. In that time, Traefik gives 502 and installs use the mirror.
2. The dwn-server can use only one did:dht gateway. If `relay.pkarr.org` is down, the DWN can refuse the writes of a did:dht publisher.
3. Each DID that does the proof of work can register, because the DWN has no provider auth. The quota of each DID and `tenant.sh block` are the only limits on abuse. The server makes the proof of work harder if more than 10 registrations occur in one minute.
4. The stack test replaces Let's Encrypt with a demo CA. Only `check.sh` on the real VPS proves the ACME settings.
