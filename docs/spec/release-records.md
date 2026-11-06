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
4. `proofPurpose` is `assertionMethod`. The key of `verificationMethod` must be in the current `assertionMethod` of the publisher DID document. A did:plc document has no `assertionMethod`. For a did:plc publisher, a key in `verificationMethod` with the fragment `didpkg-<n>` (for example `#didpkg-1`) counts as an `assertionMethod` key. Other did:plc keys, for example `#atproto`, do not count.
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

Example: the DID `did:web:example.com:pkgs` has the endpoint `https://pkgs.example.com/`. Its index is at `https://pkgs.example.com/hello/index.json`.

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

## 6. XID publishers

A XID publisher has a XID ([BCR-2024-010](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-010-xid.md)) in place of a DID. Its keys are in a XID document: a Gordian Envelope ([draft-mcnally-envelope-12](https://datatracker.ietf.org/doc/draft-mcnally-envelope/)). The XID spec has no resolution method and no recency rule. Thus didpkg sets the rules in this section.

Reference code: [`packages/core/src/xid/`](../../packages/core/src/xid/) (`document.ts`, `resolve.ts`, `release.ts`).

### The XID document

1. The document is the tagged CBOR bytes (tag 200) of the envelope. The proposed media type is `application/envelope+cbor` (draft-mcnally-envelope-12 section 8.2).
2. The inception key must sign the wrapped document. The XID must be the XID of the inception key.
3. The document must have a provenance mark. Without a mark, no rule can order two copies of a document.
4. Permissions are deny-first. A `deny` of a privilege, or of `All`, removes the privilege, also if an `allow` gives it. Note: the delegate example in BCR-2024-010 uses `deny All` with `allow Sign` to mean "only Sign". didpkg follows the rule text, not the example.
5. A text XID is 64 lowercase hex characters. `didpkg name` also takes a `ur:xid` that holds a bare XID or a XID document. It does not verify that document.
6. `didpkg id create --xid` makes a document with the inception key (nickname `inception`) and one release key (nickname `release`, only `Sign`). It can also have one DWN key (nickname `dwn`, only `Auth`). A verifier uses the privileges, not the nicknames.
7. A DWN is a service with the capability `DecentralizedWebNode`, a reference to a key with `Auth`, and the permission `Auth`. A static mirror is a service with the capability `DIDPackageRepository`, a reference to a release key, and the permission `Sign`. A service has one URI, thus each mirror has its own service.
8. Each mirror has a `dereferenceVia` URI: `<mirror>/xid/<hex>.envelope`.
9. Each change of the document adds the next provenance mark (`seq` + 1), and the inception key signs the new document.

### Resolution

1. The sources are the `http:` and `https:` `dereferenceVia` URIs of the cached document, then the resolvers. The document URL at a resolver is `<base>/xid/<hex>.envelope`.
2. A reader gets the document from each source in parallel, with the network limits of the DID drivers (5 s, https only, no private host). The limit for a document is 64 KB.
3. The valid document with the highest provenance `seq` wins.
4. A client cache keeps the newest document for each XID. A new document must have the same chain id and a `seq` that is not lower. The same `seq` needs the same mark. The next `seq` must follow the hash chain of the mark. A gap in `seq` checks only the chain id and the order.
5. If no source gives a valid document, the cached document is the result.
6. Errors: `XID_INVALID`, `XID_MISMATCH`, `XID_NO_PROVENANCE`, `XID_CHAIN`, `XID_ROLLBACK`, `XID_FORK`, `XID_NOT_FOUND`, `XID_UNAVAILABLE`.

### Release records and indexes

A XID publisher signs the same 2 objects as a DID publisher (sections 1 and 2), but each object is a Gordian Envelope, not JSON. The verifier uses the same policy for the 2 kinds: the index sequence, the pins, the status, the digest match and the tarball check.

The envelope of an object:

1. The subject is the text of `type`: `"DidPkgRelease"` or `"DidPkgIndex"`.
2. Each other member is one assertion. The predicate is the member name, as text. An object can have only one assertion for each predicate.
3. The object of `publisher` is the XID (CBOR tag 40024). In the verifier, `publisher` is the XID in hex.
4. The object of the index member `releases` is an array in publish order. Each item is a map with `version` and the members of the entry (`digest`, `status`, `message`).
5. The object of each other member is the JSON value, as dCBOR ([draft-mcnally-deterministic-cbor](https://datatracker.ietf.org/doc/draft-mcnally-deterministic-cbor/)).
6. The publisher wraps the envelope, then signs the wrapped envelope (draft-mcnally-envelope-12 `signed` assertions). On a key rotation, the index has 2 signatures: the new key and the old key.
7. A host stores and serves the tagged CBOR bytes (tag 200) of the signed envelope.

Digests and elision:

1. The content digest is `sha256-` and the base64 of the envelope digest of the unsigned object (the envelope inside the wrapper). It has the same form as a JSON content digest (section 3), and it has the same uses.
2. Elision does not change the envelope digest. Thus a publisher or a host can elide an assertion, and the digest and the signatures stay valid.
3. The verifier ignores an elided or an obscured assertion. If the schema needs that member, the check fails (`MANIFEST_SCHEMA`, `INDEX_SCHEMA`).

Keys:

1. A release key is a key of the current XID document with the `Sign` privilege (permission rule 4 above). The inception key is not a release key.
2. A signature by the inception key fails (`INDEX_SIGNATURE`, `MANIFEST_SIGNATURE`), also next to a valid signature. The inception key controls the XID document, as the did:dht key `#0` controls the DID (section 4 item 5).
3. The index must have a signature by a release key. A release record with no signature by a current release key passes only if the current index gives its digest (section 4 item 7).
4. A pin keeps each key as the hex of the tagged CBOR of its public keys. A key change needs a signature by a pinned key, as for a DID publisher.
5. A resolution failure gives a XID error (`XID_NOT_FOUND`, `XID_MISMATCH`, and the other XID errors above). Each other failure gives the policy error of the DID verifier.

### Storage

A static mirror of a XID publisher uses the static layout v1 (section 5), with these changes:

| Path | Content | Changes? |
|---|---|---|
| `xid/<hex>.envelope` | The signed XID document, as tagged CBOR | Yes |
| `<name>/index.envelope` | The index, as the tagged CBOR of the signed envelope | Yes |
| `<name>/<version>.envelope` | The release record, as the tagged CBOR of the signed envelope | No |
| `<name>/<version>.tgz` | The `npm pack` bytes, with no wrapper | No |

1. The storage endpoints are the services of the XID document. Each service with the capability `DecentralizedWebNode` comes first, then each service with the capability `DIDPackageRepository`. Each group is in document order. Each service has one URI. A repository URI must end with `/`.
2. A mirror is also a XID resolver: the document path is the resolver path of the Resolution part above.
3. The CLI writes the XID document first, then the tarball, the release record and the index.
4. A DWN of a XID publisher uses the DWN protocol v2 ([ADR 0003](../adr/0003-storage-contract.md) section 9). The index and the release record have the data format `application/envelope+cbor`. The DWN tenant is the `did:key` (W3C CCG did:key v0.9) of one key of the DWN service. It is the first key with the privilege `Auth` and an Ed25519 public key. A DWN service with no such key gives no endpoint. The DWN key signs the DWN messages. That signature is not a trust input (section 5).
5. A DWN does not hold the XID document. A reader gets the document from a XID resolver first, because the document gives the DWN and the tenant.
6. The tarball URL of the shim has only `rec`, with no `vm`. A Gordian signature does not name its key, and a key from the current document changes after a rotation. Thus the URL of a version stays the same.
