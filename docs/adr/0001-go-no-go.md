# ADR 0001: Gate 1 (Phase 0 go/no-go)

- Status: ACCEPTED: GO (2026-10-27, 16:45 EDT). Exit criterion 3 closed on 2026-10-28 at 11:25 EDT: the DID did not decay in 24 h, and the public keyless re-PUT passed. See [Decision](#decision).
- Date: 2026-10-27 (spike 06 added 15:10 EDT, decision 16:45 EDT)
- Deciders: bnonni (go/no-go), agent (evidence)
- Evidence folder: `~/spikes/didpkg-p0/` (re-run: `./run-all.sh`). The evidence paths below are relative to this folder. Since the reboot commit (2026-10-27), this file is in `bnonni/didpkg` `docs/adr/`.

## Context

PLAN.md Phase 0 proves 6 risky links before the build starts. Spike 06 (the publisher DWN as the first storage adapter) was added on 2026-10-27, after the DWN-first decision. GO only if all 5 exit criteria are true.

## Versions

| Item | Version |
|---|---|
| Bun (gate runtime) | 1.4.4, local copy in `~/spikes/didpkg-p0/bin` (npm package `bun@1.4.4`; the global Bun stays 1.3.11) |
| Node (record only) | v24.21.0 |
| npm / pnpm | 11.19.0 / 11.28.9 |
| Exact pins | `@enbox/dids` 0.1.14, `@noble/ed25519` 3.2.0, `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `@scure/base` 2.4.0, `canonicalize` 5.1.0 (install with `--ignore-scripts`) |
| Spike 06 pins | `@enbox/dwn-sdk-js` 0.4.29 and `@enbox/dwn-clients` 0.4.37 (in the spike `package.json`); `@enbox/dwn-server` 0.1.45 in `06-dwn/server/` (a separate process, 112 packages, 76 MB) |
| DID document v2 (spike 06, local only) | The same DID plus `#dwn` (type `DecentralizedWebNode`, `http://127.0.0.1:39917`). DNS packet 528 bytes (limit 1000). Only a relay on 127.0.0.1 has it: a public re-PUT would reset the decay test. |
| Publisher DID | `did:dht:df6h6n9zksp86p7d957xtmmu3w64mwb8mdcza6iu8p9ew8i9jq4o` (`#didpkg-1` in `assertionMethod`, `#pkg` of type `DIDPackageRepository` with 2 endpoints) |
| Install name | `@didpkg/hello_dht_df6h6n9zksp86p7d957xtmmu3w64mwb8mdcza6iu8p9ew8i9jq4o` |
| Static hosts | https://bnonni.github.io/didpkg-spike-pages/ and https://raw.githubusercontent.com/bnonni/didpkg-spike-pages/main/ |

## Results

| Spike | Result | Evidence |
|---|---|---|
| 01 did:dht | Local: 6/6 (second-process resolve, keyless re-PUT, tampered PUT rejected, failover). Public: PUT 204 at 2026-10-27T15:24:51Z; both `relay.pkarr.org` and `pkarr.pubky.org` resolve, all checks pass. Payload 521 bytes (limit 1000). Type test: only the exact string `DIDPackageRepository` is accepted (3/3). | `01-did-dht/results/` |
| 01 decay | +2 h (2026-10-27T17:25Z), +6 h (2026-10-27T21:25Z) and +24 h (2026-10-28T15:25Z): PASS. Both relays resolve, versionId 1793113192, signature valid, all checks pass (4.4 s each at +2 h, less than 1 s each at +6 h and +24 h). Keyless re-PUT to `relay.pkarr.org` at 2026-10-28T15:25:09Z: 204. Check after the re-PUT (15:25:41Z): PASS on both relays, same versionId. `pkarr.pubky.org` never got a direct PUT. | `01-did-dht/results/decay.jsonl` |
| 02 sign and publish | 9/9. The W3C `eddsa-jcs-2022` vector is byte-exact. Only `#didpkg-1` signs. Layout v1 for 2 versions; both verify end to end. | `02-sign-publish/results-bun-1.4.4.json` |
| 03 real hosts | 17/17. Anonymous GET, same bytes, `access-control-allow-origin: *` on both hosts. `verifyRelease` passes with no override. | `03-pages/results-bun-1.4.4.json` |
| 04 shim install | 9/9. npm 11, pnpm 11 and `bun add` install from the real hosts in a clean HOME with one `.npmrc` line and a cold cache. Frozen installs pass on pnpm and bun. `npm ci` fails with EINTEGRITY if the shim changes the bytes. | `04-shim-install/results-bun-1.4.4.json` |
| 05 negatives | 12/12. Dead endpoint, stale mirror, one bad mirror, all bad mirrors (502), forged index (403), rollback (403), swapped manifest (403), wrong `package.json` name (403), yank (hidden; `npm ci` passes), revoke (`npm ci` gives E403). | `05-negatives-runtime/results-negatives-bun-1.4.4.json` |
| 05 Node 24 (record) | 5/5. Core, did:dht driver and the shim behind `node:http`; npm installs through it. | `05-negatives-runtime/results-node-v24.21.0.json` |
| 06 DWN | 30/30. Pinned `dwn-server` 0.1.45 on 127.0.0.1 (open mode, then tenant-gate mode). Protocol install 202. The spike 02 bytes (package, 2 releases, 2 tarballs, index) all 202, signed with `#didpkg-1` only: every stored message has kid `#didpkg-1`. Wrong key 401 (`GeneralJwsVerifierInvalidSignature`), unknown kid 401 (`GeneralJwsVerifierGetPublicKeyNotFound`). `$immutable` release and tarball updates fail (`ProtocolAuthorizationImmutableRecord`); the index update gives 202. Anonymous DRL reads return the exact signed bytes; a nested read with no `filter.contextId` gives 400. From the DWN only (no mirror request): npm 11 install, lockfile pins, `npm ci`, `npm ci` with changed bytes fails (EINTEGRITY), pnpm 11 add and frozen install, `bun add` and frozen install, all on cold caches. A forged duplicate `hello` record (sequence 99) is rejected. DWN stopped: npm, pnpm and bun install from the Pages mirror. Tenant gate: unknown DID 401, admin registration 201, then 202. `bun pm ls`: one `@enbox/dids` (0.1.14). | `06-dwn/results-bun-1.4.4.json` |
| Criterion 4 | `did-trust-model/run-all.sh`: all proofs pass, results equal the 2026-10-23 run. `name-grammar`: `bun test` 8 pass, 0 fail. | `check/` |

## Exit criteria

1. Spikes 01-06 pass with the exact pins on Bun 1.4.4: YES (decay check: see 3). `run-all.sh` on 2026-10-27 at 14:54 EDT: all gate spikes pass, Node 5/5.
2. Clean HOME install with npm, pnpm add, and `npm ci` fails on changed bytes: YES, from the static mirror (spike 04) and from the DWN only (spike 06).
3. Decay times recorded, and a keyless re-PUT brings the DID back: YES (2026-10-28). No decay in 24 h on both relays. The public keyless re-PUT got 204, and the DID resolves after it. The DID did not expire, thus the public test did not show a return from expiry. See the note on relay caching in [Decision](#decision).
4. `did-trust-model/run-all.sh` and `name-grammar` `bun test` on Bun 1.4.4: YES.
5. This ADR records versions, hours, the Node result, the bun result and the decision: YES.

No-go triggers: none hit so far. No third-party patch was necessary. Spike 06 passes, so the "DWN fail" branch of PLAN.md does not apply.

## Hours

About 1.7 hours of agent time, against the 22 h cap: spikes 01-05 about 1 hour (2026-10-27, 10:54-11:55 EDT), spike 06 about 0.7 hours (14:26-15:10 EDT; estimate was 4-8 h). The research prototypes in `research/phase3/` and the Enbox source facts in `research/phase2/research_enbox-gitd.json` did most of the work. The 24-hour decay check is calendar time, not work time.

## Findings for Phase 1

1. **`#0` is in `assertionMethod` by default.** `@enbox/dids` adds the identity key `#0` with all 4 purposes. Thus a release that `#0` signs passes (with the `HOT_UPDATE_KEY` warning of PLAN.md step 2). Option: create `#0` without `assertionMethod`, so a `#0` signature fails. Needs a decision before `didpkg id create`.
2. **GitHub Pages adds `Content-Encoding: gzip` to `.tgz` files** (gzip on gzip, 328 wire bytes for a 305-byte file). `fetch` decodes it, so the bytes match. The layout spec must say: readers decode `Content-Encoding` before the sha512 check.
3. **Cache delay.** Pages sends `max-age=600`, raw.githubusercontent `max-age=300`. A reader can see an old index for up to 10 minutes after a publish. The highest valid sequence across endpoints limits the effect.
4. **`pk` in the tarball URL comes from the current DID document.** After a key rotation, the shim cannot fill `pk` for old releases, so the packument of an old version changes, and pnpm frozen installs fail (`ERR_PNPM_TARBALL_URL_MISMATCH`). Fix: put the signer's `publicKeyMultibase` in the signed manifest, or drop `pk` for rotated keys from the start.
5. **Pkarr `seq` is in seconds** (`1793113192`), not microseconds. Two DID updates in the same second collide. Low risk.
6. **The spike keyfile holds `#0`.** `01-did-dht/state/did.portable.json` (mode 600) holds both keys. Phase 1 must split it: `#0` cold, `#didpkg-1` in the encrypted keyfile.
7. Known from before: `HASH_RE` accepts impossible last characters (fix: `/^[a-z2-7]{51}[aq]$/`).

### From spike 06 (the DWN)

1. **The DWN does not check the verification relationship.** The JWS verifier finds the key with `kid.endsWith(method.id)` and reads only `publicKeyJwk` (`dwn-sdk-js/src/jose/jws/general/verifier.ts`). Any key in `verificationMethod` can sign DWN writes, `#0` too. Thus "never `#0` at publish" is a CLI rule. The DWN cannot enforce it.
2. **Set the did:dht gateway on the server.** A stock `dwn-server` resolves did:dht through `https://enbox-did-dht.fly.dev` (the `@enbox/dids` fallback). That gateway returned 404 for the spike DID ("too many requests for bad key"), and `relay.pkarr.org` returned it (200), on 2026-10-27. The VPS must set `DID_DHT_GATEWAY_URI=https://relay.pkarr.org`. Only one gateway URI is possible. A private relay also needs `DID_DHT_ALLOW_PRIVATE_GATEWAY=1`. No code change is necessary.
3. **Tenant settings** (`dwn-server/src/config.ts`, `registration/registration-manager.ts`, `admin/admin-api.ts`):
   - Open (default): no `DWN_REGISTRATION_STORE_URL`, so every DID can write.
   - Allowlist (for the didpkg VPS): `DWN_REGISTRATION_STORE_URL=sqlite://data/registration.db`, `DWN_TTL_CACHE_URL` with the same URL, `DWN_ADMIN_TOKEN`, no proof-of-work, no provider auth. Add a publisher with `POST /admin/api/tenants {"did": ...}` and the bearer token (201). The server logs a warning that new tenants cannot register; that is the purpose. Tested: 401 before registration, 202 after, 202 after a restart (`06-dwn/allowlist-persist.ts`). Without `DWN_TTL_CACHE_URL`, the server stops at boot.
   - Proof-of-work (`DWN_REGISTRATION_PROOF_OF_WORK_ENABLED=true`) and provider auth (`DWN_PROVIDER_AUTH_ENABLED=true` plus a JWT secret or plugin) let new DIDs register themselves. Neither limits writes to known DIDs.
   - The admin API is on the same port. The reverse proxy must block `/admin` from the internet. The tenant list route needs SQL message storage ("Admin store unavailable" with LevelDB).
4. **No `pattern` in tag schemas.** The TypeScript type `ProtocolTagSchema` lists `pattern`, but the runtime JSON schema rejects it (`SchemaValidatorAdditionalPropertyNotAllowed`). Only `enum`, length, range and item keywords pass. The reader and the verifier check names, not the DWN.
5. **`RecordsWrite.createFrom` does not copy the tags.** An update without `tags` fails for the tag schema (`ProtocolAuthorizationTagsInvalidSchema`), not for `$immutable`. The writer must pass the tags again.
6. **Package names are not unique in a DWN.** The reader queries every `package` record with the tag `name` and tries each context. Tested with a forged duplicate. The highest valid signed index wins.
7. **Request count and rate limits.** Each read is 2 requests (a query for the package `contextId`, then the DRL read). A cold install of one package with 2 versions is about 12 DWN requests (6 for the packument, 6 for the tarball), from the reader code. The server limits are 30 requests/s per IP and 20 per tenant. Phase 1 must cache the `contextId` and the index per install. Large dependency trees can get 429.
8. **The protocol read returns the newest published record** (`limit 1`, published date descending). The index is one record, updated in place; `createFrom` keeps `datePublished`.
9. **Two copies of `@noble/curves`** (2.2.0 for Enbox, 2.4.0 for the core pin). This was true before spike 06. Option for Phase 1: pin 2.2.0 in the core.
10. **The server starts in 0.2-0.4 s** on Bun 1.4.4 with LevelDB. DRL tarballs come back with `content-type: application/gzip` (the `dataFormat`); npm does not check it.

## Decision

**GO**, on 2026-10-27 at 16:45 EDT. bnonni made the decision before exit criterion 3 was complete: "GO now and adjust later if needed based on tomorrow's findings."

Reasons:

1. Spikes 01-06 pass. Exit criteria 1, 2 and 4 are true. No no-go trigger is hit.
2. The local part of spike 01 proved a keyless re-PUT (6/6). Only the public result is open.
3. The +2 h public check passed on both relays.
4. A failed public re-PUT changes only the did:dht retention commands: the re-PUT in `didpkg publish`, `didpkg id republish` and the re-PUT at install. It does not change `@didpkg/core` `name/` and `trust/`, or `@didpkg/adapter-dwn`.

Checks after the decision (systemd user timers, output in `01-did-dht/results/decay.jsonl`):

1. +6 h check: 2026-10-27, 17:25 EDT. PASS.
2. +24 h check, then a keyless re-PUT: 2026-10-28, 11:25 EDT. PASS.

The "01 decay" row and exit criterion 3 have the results.

If the public keyless re-PUT does not bring the DID back:

1. Record the relay responses in this ADR.
2. Make did:web the default publisher method for Phases 1-2 (the Pkarr fallback of PLAN.md no-go trigger 1).
3. Move the did:dht retention design to decision 6 (before Phase 2).

If the DID stays resolvable at +24 h with no re-PUT, record it as a note on relay caching. The decision stays GO.

Note on relay caching (2026-10-28): the DID stayed resolvable at +24 h with no re-PUT, on both relays. The cause is not known: a relay cache, or DHT nodes that keep the record. `pkarr.pubky.org` got the record only through the DHT or its own cache. Thus 24 h is not a measured DHT lifetime. Decision 6 (did:dht retention, before Phase 2) must not use it as a proven value. The did:web fallback does not apply. The decision stays GO.
