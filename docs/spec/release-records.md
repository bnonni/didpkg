# Release records and the storage layout (v1)

Version: v1. A later v1 revision can add members, but it does not remove or change a member.

Reference code: [`packages/core/src/trust/`](../../packages/core/src/trust/) (`release.ts`, `digest.ts`, `proof.ts`, `verify.ts`). Decisions: [ADR 0003](../adr/0003-storage-contract.md) sections 6 and 7. The install checks: [How didpkg works](../how-it-works.md).

A publisher signs 2 kinds of JSON objects for each package:

| Object | Count | Changes? | Role |
|---|---|---|---|
| `DidPkgRelease` (the release record) | 1 for each version | No | It binds the version to the exact tarball bytes. |
| `DidPkgIndex` (the index) | 1 for each package | Yes | It lists the versions and their status. It is the commit point. |

The storage host is not trusted. A reader must parse and check each object before use (`parseRelease`, `parseIndex`). A v1 reader accepts members that it does not know.

## 1. The release record

| Member | Value |
|---|---|
| `type` | `"DidPkgRelease"` |
| `specVersion` | `"1"` |
| `publisher` | The publisher DID. It must be the DID of the install name. |
| `name` | The pkg-name, with no scope ([install names](install-names.md)). |
| `version` | A SemVer 2.0.0 version. |
| `published` | The publish time (an XML Schema `dateTimeStamp`). It is a claim of the publisher. A verifier must not use it for a security decision. |
| `dist` | `integrity`: the sha512 SRI string of the exact `.tgz` bytes. `size`: the number of bytes. |
| `npm` | The fields of the version in the packument, for example `dependencies`, `bin`, `engines` and `hasInstallScript`. |
| `previous` | `{ "version": ..., "digest": ... }` of the release before this one in publish order, or `null` for the first release. Thus the releases make a hash chain. |
| `proof` | One Data Integrity proof (section 4). |

The live demo record `hello/1.0.0.json` of [bnonni/didpkg-demo](https://github.com/bnonni/didpkg-demo):

```json
{
  "type": "DidPkgRelease",
  "specVersion": "1",
  "publisher": "did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy",
  "name": "hello",
  "version": "1.0.0",
  "published": "2026-10-28T20:41:12Z",
  "dist": {
    "integrity": "sha512-qa1JOuvzD6wPtfFBewB39/tlS3lMXHaiPukx1gT/9dkX+znRN2ZtZJsZkRw/4M5WjR5kG8BHx/gwkfsvmdTxkQ==",
    "size": 248
  },
  "npm": { "hasInstallScript": false },
  "previous": null,
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-10-28T20:41:12Z",
    "verificationMethod": "did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy#didpkg-1",
    "proofPurpose": "assertionMethod",
    "proofValue": "z5ZTdwHycdsWJzskhc32ph1SC9Z2MGn91fwPYAoWAFYLYpJ1iDP4dp3oEwL4ACxunnKg4dqidsU5YzijeCZWVGzZA"
  }
}
```

## 2. The index

| Member | Value |
|---|---|
| `type` | `"DidPkgIndex"` |
| `specVersion` | `"1"` |
| `publisher`, `name` | The same as in the release records. |
| `sequence` | An integer, 1 or more. It must increase with each new index of one signing key. |
| `updated` | The index time. It is a claim of the publisher. |
| `previous` | The content digest of the index before this one, or `null`. |
| `distTags` | A map from a tag to a version, for example `{ "latest": "1.0.0" }`. Each version must be in `releases`. |
| `releases` | A map from a version to `{ "digest": ..., "status": ..., "message": ... }`. `digest` is the content digest of the release record. `message` is optional. |
| `proof` | One proof, or a set of proofs on a key rotation: the new key and the old key. |

The index owns the status of each version:

| Status | Packument | Install |
|---|---|---|
| `active` | Listed | Yes |
| `deprecated` | Listed, with the npm deprecation message | Yes, with a warning |
| `yanked` | Not listed | Only from an exact lockfile pin |
| `revoked` | Not listed | No (HTTP 403) |

## 3. Digests

1. The content digest of a signed object is `sha256-` and a base64 hash. The hash is the SHA-256 of the JCS form (RFC 8785) of the object with no `proof` member. The index uses it in `releases.*.digest` and `previous`. A release record uses it in `previous.digest`. The shim uses it in the `rec` query of a tarball URL.
2. `dist.integrity` is the W3C Subresource Integrity string of the tarball: `sha512-` and the base64 of the SHA-512 of the exact bytes. npm keeps the same string in the lockfile.

## 4. Proofs

1. A proof is a W3C Data Integrity proof with `type` `"DataIntegrityProof"`.
2. The cryptosuite is `eddsa-jcs-2022` (Ed25519, VC DI EdDSA 1.0 section 3.3) or `bip340-jcs-2025` (secp256k1 Schnorr, an editor's draft). `proofValue` is the multibase base58btc form of the signature (it starts with `z`).
3. The signed data has 64 bytes: the SHA-256 of the JCS form of the proof with no `proofValue`, then the SHA-256 of the JCS form of the object with no `proof`. `bip340-jcs-2025` signs the SHA-256 of these 64 bytes.
4. `proofPurpose` is `assertionMethod`. The key of `verificationMethod` must be in the current `assertionMethod` of the publisher DID document.
5. `didpkg publish` signs with the release key `#didpkg-1`. A verifier refuses a proof by the did:dht update key `#0` (`INDEX_SIGNATURE`, `MANIFEST_SIGNATURE`).
6. `created` is a claim of the publisher. A verifier must not use it for a security decision.
7. The content digest of each release record must be the digest that the current signed index gives for its version. After a key rotation, the old key is not in the DID document. Then only this digest vouches for the release record.

## 5. The storage layout

A reader finds the storage in the DID document:

1. Each service with the type `DecentralizedWebNode` gives a DWN. A reader tries these first.
2. Each service with the type `DIDPackageRepository` gives static mirrors, in document order. `serviceEndpoint` is a URL string or a set of URL strings. Each URL must end with `/`.
3. Each host gives the same bytes, because the CLI serializes each object one time.
4. The highest valid `sequence` of an index wins. For a release record or a tarball, the first copy that passes the checks wins.

### Static layout v1

The paths are relative to the endpoint URL:

| Path | Content | Changes? |
|---|---|---|
| `<name>/index.json` | The index | Yes |
| `<name>/<version>.json` | The release record | No |
| `<name>/<version>.tgz` | The `npm pack` bytes, with no wrapper | No |
| `didpkg.json` | The repository root. Optional. didpkg 0.1.0 does not read or write it. | Yes |

1. Each path segment is the `encodeURIComponent` of the name or the version, with `+` as `%2B`. Each segment must match `^[0-9A-Za-z][0-9A-Za-z.+-]*$`.
2. A reader uses only `https:` with no private host.
3. Only HTTP 404 and 410 mean "absent". Each other status, also 403, is a failure of the endpoint.
4. The CLI writes the tarball, then the release record, then the index. Thus a reader never sees an index entry with no files.
5. The CLI does not change a published release record or tarball.

Example: the DID `did:web:bnonni.github.io:didpkg-demo` has the endpoint `https://bnonni.github.io/didpkg-demo/web/`. Its index is at `https://bnonni.github.io/didpkg-demo/web/hello/index.json`.

### DWN protocol v1

The protocol URI is `https://didpkg.dev/protocols/repository/v1`. The full protocol definition is in [ADR 0003](../adr/0003-storage-contract.md) section 6.

| Protocol path | Content | Tags |
|---|---|---|
| `package` | `{ "name": ... }`. Not a trust input. | `name` |
| `package/index` | The exact bytes of the index | none |
| `package/release` | The exact bytes of the release record. Immutable. | `version` |
| `package/release/tarball` | The `npm pack` bytes. Immutable. | `version` |

1. Anyone can read. Only the DID (the tenant) can write.
2. A reader uses the anonymous HTTP routes of `dwn-server` and needs no keys ([ADR 0003](../adr/0003-storage-contract.md) section 6 item 2).
3. A DWN can have more than one `package` record with one name. A reader tries each of them.
4. The CLI writes the release record, then the tarball, then the index. It signs each DWN message with `#didpkg-1`. The DWN signature is not a trust input.
