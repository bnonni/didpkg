# ADR 0003: The storage contract and PackageSource

- Status: ACCEPTED (2026-10-27)
- Date: 2026-10-27
- Deciders: bnonni (DWN first, 2026-10-27), agent (the merge of the prototypes)
- Code: `packages/core/src/source/`, the `ReleaseReader` change and `checkRelease` in `packages/core/src/trust/verify.ts`. Tests: `packages/core/test/source/`.
- Amended: 2026-10-27, section 8 (the npm packument, chunk C4b); section 7 items 1-5 (the static HTTPS adapter, chunk C5). Code: `packages/adapter-https/`.

## Context

Two prototypes read package storage:

1. `research/phase3/storage-adapters/proto.ts` and `storage-adapter.ts`: a static HTTPS adapter and a `Source` facade. `Source` verifies proofs with its own `verifyProof` and selects the index by `seq`. Thus it holds a second copy of the trust logic.
2. Spike 06 (`~/spikes/didpkg-p0/lib/store.ts`, `lib/dwn-store.ts`, `06-dwn/protocol.json`): an HTTPS store and a DWN store behind one `PackageStore`. It returns every index copy, and it selects a manifest and a tarball by the digest in the signed data. Spike 06 passed 30 of 30 checks.

The C3 verifier (`trust/verify.ts`) read one index from a `ReleaseReader`. PLAN.md step 2 requires more: get the index from every endpoint, and the highest valid `sequence` wins. A DWN can also hold two `package` records with one name (PLAN.md DWN rule 7).

## Decision

### 1. Trust stays in trust/

Adapters move bytes. `PackageSource` selects copies only by digests in signed objects. `trust/` verifies everything again. No storage code decides trust.

### 2. The verifier gets candidates

`ReleaseReader` (in `trust/verify.ts`) changes to the spike 06 shape:

```ts
interface ReleaseReader {
  getIndexes(did: string, name: string): Promise<unknown[]>;
  getRelease(did: string, name: string, version: string, digest: string): Promise<unknown>;
  getTarball(did: string, name: string, version: string, dist: { integrity: string; size: number }): Promise<Uint8Array | null>;
}
```

`verifyIndex` checks each index copy: the schema, `publisher` and `name`, and a proof by a key in `assertionMethod` now. The copy with the highest `sequence` wins. On a tie, the first copy wins (the DWN first). If no copy is valid, the error of the first copy is the result. The pin checks (step 3) then run on the winner.

### 3. The adapter contract

```ts
type StoredFile = { kind: 'index'; name } | { kind: 'release'; name; version } | { kind: 'tarball'; name; version };

interface StorageReader {        // one endpoint, anonymous, no keys
  read(file: StoredFile, options: { signal: AbortSignal; maxBytes: number }): AsyncIterable<Uint8Array>;
}
interface StorageAdapter {
  readonly kind: string;
  canRead(endpoint: Endpoint): boolean;            // the service type and the URL scheme
  reader(endpoint: Endpoint, deps: { fetch: typeof fetch }): StorageReader;
}
interface StorageWriter {
  publish(input: { name; version; release: Uint8Array; tarball: Uint8Array; index: Uint8Array }): Promise<void>;
  writeIndex(input: { name; index: Uint8Array }): Promise<void>;
}
```

1. A reader yields the exact stored bytes of each copy. A static mirror has 0 or 1 copies. A DWN can have more. An absent file yields nothing. A failed endpoint throws.
2. Core parses the JSON. Thus each adapter stores and returns the same bytes, and the parse rules are in one place.
3. A writer gets bytes, not objects. The CLI serializes each signed object one time. Thus the DWN bytes and the mirror bytes are equal (Phase 1 exit criterion).
4. The index write is the commit point. A writer writes it last. The DWN writer writes the release, then the tarball, then the index. The static writer writes the tarball, then the release, then the index.
5. `writeIndex` does each status change (yank, deprecate, revoke) and each dist-tag change.
6. Each adapter package exports its own writer constructor, because the credentials differ (a DWN signing key, a folder path). Core has no writer factory.
7. A reader must refuse a private network address, unless a test option allows the loopback address. The adapters use `isPrivateHost` from `did/` (C5 and C7).

### 4. Endpoint selection

`storageEndpoints(doc)` in `source/endpoints.ts`:

1. The type match is exact and case sensitive: `DecentralizedWebNode` and `DIDPackageRepository`. The service `type` is a string or a set of strings (DID Core 1.0 section 5.4). The tests reject `DidPackageRegistry`, `DidPackageRepository` and 6 other near names.
2. Each `DecentralizedWebNode` endpoint comes first, then each `DIDPackageRepository` endpoint. Each group is in document order.
3. Only string endpoints. A map endpoint is not used in v1.
4. A URL must parse, and it must not have credentials, a query or a fragment. A repository URL must end with `/` (RFC 3986 section 5). A DWN URL need not.
5. A duplicate URL is used one time. The maximum is 8 endpoints (`MAX_ENDPOINTS`), so a hostile document cannot make one install send many requests.
6. A service id becomes an absolute DID URL.

### 5. Reads in PackageSource

| File | Order | Limit | Time limit per endpoint |
|---|---|---|---|
| Index | All endpoints in parallel. Every JSON copy is a candidate. | 256 KiB (`MAX_JSON_BYTES`) | 5 s |
| Release | Endpoint order. The first copy whose `contentDigest` is the index entry digest. | 256 KiB | 5 s |
| Tarball | Endpoint order. The first copy with the size and the sha512 of the release `dist`. | 64 MiB (`MAX_TARBALL_BYTES`) | 30 s |

1. The limits are the `$size` limits of the DWN protocol. Core checks the size again after the adapter.
2. Core checks the package name (`PKG_NAME_RE`) and the version (SemVer 2.0.0) before an adapter gets them. Thus no `/` and no `../` gets into an adapter path.
3. Results for the shim (C10 maps them):

| Result | When | HTTP |
|---|---|---|
| Empty list or `null` | Every endpoint answered, and no endpoint has the file. Also: no endpoint. | 404 (the verifier gives `INDEX_MISSING`, `MANIFEST_MISSING` or `TARBALL_MISSING`) |
| `SourceError('UNAVAILABLE')` | No usable copy, and at least one endpoint failed or sent bad JSON. | 502 |
| `SourceError('MISMATCH')` | Copies arrived, but no copy has the signed digest. | 502 |

### 6. The DWN protocol v1

The spike 06 shape is final (`~/spikes/didpkg-p0/06-dwn/protocol.json`, 30 of 30 checks on `@enbox/dwn-server` 0.1.45):

```json
{
  "protocol": "https://didpkg.dev/protocols/repository/v1",
  "published": true,
  "types": {
    "package": { "schema": "https://didpkg.dev/schemas/package/v1", "dataFormats": ["application/json"] },
    "index": { "schema": "https://didpkg.dev/schemas/index/v1", "dataFormats": ["application/json"] },
    "release": { "schema": "https://didpkg.dev/schemas/release/v1", "dataFormats": ["application/json"] },
    "tarball": { "dataFormats": ["application/gzip"] }
  },
  "structure": {
    "package": {
      "$actions": [{ "who": "anyone", "can": ["read"] }],
      "$tags": { "$requiredTags": ["name"], "name": { "type": "string", "minLength": 1, "maxLength": 64 } },
      "$size": { "max": 4096 },
      "index": { "$actions": [{ "who": "anyone", "can": ["read"] }], "$size": { "max": 262144 } },
      "release": {
        "$immutable": true,
        "$actions": [{ "who": "anyone", "can": ["read"] }],
        "$tags": { "$requiredTags": ["version"], "version": { "type": "string", "maxLength": 256 } },
        "$size": { "max": 262144 },
        "tarball": {
          "$immutable": true,
          "$actions": [{ "who": "anyone", "can": ["read"] }],
          "$tags": { "$requiredTags": ["version"], "version": { "type": "string", "maxLength": 256 } },
          "$size": { "max": 67108864 }
        }
      }
    }
  }
}
```

1. The `name` tag maximum (64) is `MAX_PKG_NAME` in `name/`.
2. The DWN reader maps `StoredFile` to these anonymous routes (`filter.contextId` is a subtree match):
   - `GET <dwn>/<did>/query?filter.protocol=<P>&filter.protocolPath=package&filter.tags.name=<name>` gives the package `contextId` values.
   - `GET <dwn>/<did>/read/protocols/<base64url P>/package/index?filter.contextId=<ctx>`
   - `.../package/release?filter.contextId=<ctx>&filter.tags.version=<v>`
   - `.../package/release/tarball?filter.contextId=<ctx>&filter.tags.version=<v>`
3. The reader yields one copy per `contextId`. Thus two `package` records with one name give two candidates.
4. No `$recordLimit` `strategy` (PLAN.md DWN rule 1). CI installs the protocol on the pinned server (C6).

### 7. The static layout v1

PLAN.md "Layout v1" is final: `<name>/index.json`, `<name>/<version>.json`, `<name>/<version>.tgz`. The repository root `didpkg.json` stays optional. Phase 1 does not read or write it. A later version can add it to `StoredFile`, because v1 adds members only.

`packages/adapter-https` reads and writes this layout:

1. The reader (`httpsAdapter`) reads only a `DIDPackageRepository` endpoint with `https:` and no private host (`isPrivateHost`). The test option `allowLoopback` also allows `http:` and `https:` on `localhost`, `127.0.0.0/8` and `[::1]`. It uses `fetchBytes` from `did/`: a redirect only to the same host and protocol, no own timer (the `PackageSource` signal sets the time limit).
2. Only HTTP 404 and 410 mean "absent". Each other status, also 403, is a failed endpoint. Thus a broken mirror cannot make a published file look absent (404 instead of 502).
3. Each path segment is `encodeURIComponent` of the name or the version. Only `+` changes (`%2B`), because some hosts read a literal `+` as a space. Each segment must match `^[0-9A-Za-z][0-9A-Za-z.+-]*$`, also for a direct caller.
4. The writer (`DirWriter`, entry point `@didpkg/adapter-https/dir`) does not change a published release or tarball, because a lockfile holds their integrity. The same bytes again is a no-op, so a failed publish can run again. Each write is a temporary file and a rename.
5. The reader entry point uses no Node API, so it runs in a browser. Only `dir.ts` uses `node:fs`.

### 8. The npm packument

`buildPackument` (`source/packument.ts`) makes the packument from the result of `verifyIndex`. The shim (C10) sends it.

1. It lists the `active` and `deprecated` versions in SemVer 2.0.0 order. It omits `yanked` and `revoked` versions and does not read their manifests.
2. Each listed version must pass `checkRelease`: step 5 of the tarball route (digest, fields, proof method). Thus the packument never lists a version that the tarball route rejects.
3. If one listed manifest is absent or bad, the packument fails with the `PolicyError` of the lowest failed version. A host must not hide one signed version, because that is a selective rollback.
4. Each version is the signed `npm` fields, plus `name` (the canonical install name), `version` and `dist` (`integrity` from the signed release, `tarball` from a function of the caller). The index owns the status: a `deprecated` member in `npm` does not count. A deprecated version with no message gets `deprecated: "deprecated"`, because npm ignores an empty string.
5. `time` holds the `published` value of each listed version. It is a publisher claim. `npm install --before` reads it.
6. A dist-tag of an omitted version is dropped. If no `latest` tag is left, `latest` is the highest listed version with no prerelease, else the highest listed version. If a stable version is listed, npm selects the same version when `latest` is absent. pnpm needs the tag (not verified in this repository).

## Consequences

- Good: one trust code path. The spike 06 checks (stale mirror, swapped bytes, names that are not unique) are now unit tests on core.
- Good: an adapter is small. It maps 3 file kinds to its layout and yields bytes.
- Cost: the verifier and `PackageSource` both resolve the DID. The `DidResolver` cache (single-flight) makes the second resolution free.
- Open: if the DWN is down, a stale mirror can serve an older valid index. The pin stops a rollback in the same key epoch. On first use, the user gets the older index. Same in spike 06.
- Cost: a packument reads each listed manifest. The DWN limit is 20 requests per second per tenant, so the DWN reader (C7) caches manifests by digest.
- Open: two versions that differ only in build metadata (`1.0.0+a`, `1.0.0+b`) have one precedence. npm and pnpm can confuse them. The packument sorts them by code unit. `didpkg publish` (C9) can reject build metadata.
- Open: two valid copies with one sequence and different content (equivocation) are not detected at read time. The first copy wins. The pin detects it later (`EQUIVOCATION`).

## Rejected

1. The `proto.ts` `Source` as written: it verifies proofs itself, so it duplicates `trust/`.
2. One index per reader (C3): a stale or hostile first endpoint hides the newest valid index.
3. Readers that return parsed JSON: the bytes can differ per adapter, and each adapter needs its own parse rules.
4. A `writer(target, credentials)` factory in `StorageAdapter`: the credentials have no common type.
5. One reader method per file kind (`getIndex`, `getRelease`, `getTarball`): 3 methods per adapter for 1 map from a file to a path.
6. A packument that skips a version with an absent or bad manifest (spike `lib/shim.ts`): a host can hide the newest version, and the `latest` fallback then selects an older version.
7. HTTP 403 as "absent" (some S3 buckets answer 403 for a missing key): a broken mirror then hides a file with a 404 result. Such a bucket must allow the list permission, or it serves 502.
8. A `DirWriter` that replaces a published file (spike `proto.ts`): a new tarball for an old version breaks each lockfile with the old integrity.
