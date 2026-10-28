# Runbook: the demo DWN on a VPS

This runbook puts the demo DWN `dwn.didpkg.dev` on one VPS (PLAN.md Phase 1 item 6). Exit criterion 2 of Phase 1 needs this DWN. The files are in `deploy/`.

## What runs

| Part | Version | Task |
|---|---|---|
| `dwn` | `@enbox/dwn-server` 0.1.45 on Bun 1.4.4 (`deploy/dwn/`, built on the VPS) | The DWN, with a tenant allowlist. Its port is not published. |
| `traefik` | Traefik v3.7.16 | TLS from Let's Encrypt (TLS-ALPN challenge), the route allowlist, the limits. |
| `didpkg-dwn-backup.timer` | systemd on the host | One backup each day at 03:30 UTC (plus a random delay of up to 15 min). |

Rules of the stack:

1. Only TCP port 443 is open to the internet. Port 80 is not used.
2. Only the routes of didpkg pass: `GET /health`, `GET /info`, `POST /`, `GET /<did>/query...` and `GET /<did>/read/...`. Each other request gets 404, for example `/admin`, `/metrics` and `/registration`.
3. Only a DID that you add with `deploy/tenant.sh` can write. A DID cannot add itself: there is no proof-of-work and no provider auth.
4. Traefik allows 20 requests a second for each client IP, with a burst of 50. The dwn-server sees only the Traefik address, so its own limits are off.
5. A request body can be 17 MiB at most. A DWN record can be 16 MiB at most.
6. The data is in the Docker volume `didpkg-dwn_dwn-data` (LevelDB and `registration.db`). The certificate is in `didpkg-dwn_acme`.

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

## 4. Add a publisher (about 5 min for each publisher)

1. On your machine, make the identity with this DWN in its `#dwn` service:

   ```sh
   didpkg id create main --dwn https://dwn.didpkg.dev --repo https://<user>.github.io/<repo>/
   didpkg id create web --web <user>.github.io:<repo> --dwn https://dwn.didpkg.dev --repo https://<user>.github.io/<repo>/
   ```

   A did:dht identity goes to the default relays, `relay.pkarr.org` too. The DWN resolves did:dht through `relay.pkarr.org`. A did:web identity needs its `did.json` on the site before step 3.
2. On the VPS, add the DID that `didpkg id show <alias>` shows. The script must print `201`:

   ```sh
   /opt/didpkg/deploy/tenant.sh <did>
   ```

3. On your machine, publish:

   ```sh
   didpkg publish main <tarball> --to dwn --to dir:<site folder>
   ```

## Operate

| Task | Command (on the VPS, in `/opt/didpkg/deploy`) |
|---|---|
| See the logs | `docker compose logs --tail 100 dwn` (or `traefik`) |
| See the state | `docker compose ps` |
| Restart | `docker compose restart` |
| Update to a new commit | `git -C /opt/didpkg fetch && git -C /opt/didpkg checkout <commit> && docker compose up -d --build --wait` |
| Change the admin token | Edit `.env`, then `docker compose up -d --wait` |
| Restore a backup | `./restore.sh /var/backups/didpkg-dwn/dwn-<time>.tar.gz` |
| See the backup timer | `systemctl list-timers didpkg-dwn-backup.timer` |

To restore on a new VPS, do sections 1 and 2 first, copy the backup file to the VPS, then run `restore.sh`.

Keep a copy of the backups off the VPS. For example, run this command on your machine each week:

```sh
rsync -a root@<vps>:/var/backups/didpkg-dwn/ ~/backups/didpkg-dwn/
```

To change the pinned `dwn-server`, edit `deploy/dwn/package.json`, then run `bun install --lockfile-only --ignore-scripts` in `deploy/dwn/`. Use the same versions as the root `bun.lock`, so the DWN runs the code that the tests use. Then run `bun deploy/test/stack.ts` before you commit.

## Known limits

1. The backup stops the dwn-server for some seconds each day, because a copy of a running LevelDB is not safe. In that time, Traefik gives 502 and installs use the mirror.
2. The dwn-server can use only one did:dht gateway. If `relay.pkarr.org` is down, the DWN can refuse the writes of a did:dht publisher.
3. `tenant.sh` can only add a DID. The removal of a tenant is not tested.
4. The stack test replaces Let's Encrypt with a demo CA. Only `check.sh` on the real VPS proves the ACME settings.
