# How didpkg works

didpkg puts the trust in the DID of the publisher, not in the registry. The publisher puts a DWN (Decentralized Web Node) in its DID document and publishes each package to it. The publisher signs each release with a key from its DID document. The DWN and each backup mirror only move bytes. The shim on your computer checks each signature and each digest before npm gets a package.

## Identifier kinds

A publisher has one of 2 kinds of identifier. The install name holds the kind:

| Kind | Identifier | Document | Install name |
|---|---|---|---|
| `did` | A DID: did:dht, did:web, did:webvh, did:plc or did:btcr2 | The DID document, from the DID method | `@didpkg/hello_did_<method>_<id>` |
| `xid` | A XID ([BCR-2024-010](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-010-xid.md)): the hash of the inception key | The XID document: a Gordian Envelope, signed by the inception key | `@didpkg/hello_xid_<64 hex>` |

The parts below are the same for the 2 kinds, with these differences for a XID publisher:

- The index and the releases are signed Gordian Envelopes (`index.envelope`, `<version>.envelope`), not JSON. The release key signs them.
- The DWN uses the didpkg protocol v2.
- A XID has no DID method, so the shim cannot find the XID document from the install name. It gets the document from each XID resolver that you set (`didpkg shim start --xid-resolver <url>`). A static mirror of the publisher is a XID resolver: it holds the document at `xid/<hex>.envelope`. The DWN does not hold the XID document.

## Parts

| Part | Made by | Location | Content |
|---|---|---|---|
| Publisher DID | `didpkg id create` | did:dht: the Mainline DHT, through Pkarr relays. did:web: `https://<host>/<path>/did.json`. | The release key `#didpkg-1` in `assertionMethod`. The storage endpoints: services of type `DecentralizedWebNode` and `DIDPackageRepository`. |
| Index | `didpkg publish` | Each storage endpoint | One for each package name: a `sequence` number, each version with the digest of its release and its status, and the dist-tags. Signed with `#didpkg-1`. |
| Release | `didpkg publish` | Each storage endpoint | One for each version: the npm fields, and the size and sha512 of the tarball. Signed with `#didpkg-1`. |
| Tarball | `npm pack` | Each storage endpoint | The package files. The tarball has no signature: the signed release holds its size and its sha512. |

The storage endpoints are of 2 kinds:

- The DWN of the publisher, with the didpkg protocol v1. This is the registry of the publisher. Example: `https://dwn.didpkg.dev`.
- An optional static HTTPS mirror, as a backup copy. Its layout is `<name>/index.json`, `<name>/<version>.json` and `<name>/<version>.tgz`. Example: a GitHub Pages site.

Each endpoint holds the same signed bytes. Thus one endpoint can stop, and the install still works from the other endpoints.

## Diagram

```mermaid
sequenceDiagram
  participant npm as npm, pnpm or bun
  participant shim as didpkg shim (127.0.0.1)
  participant did as DID method (DHT or HTTPS host)
  participant store as DWN (and backup mirrors)
  npm->>shim: GET the packument of the install name
  shim->>did: resolve the DID
  did-->>shim: DID document (keys, endpoints)
  shim->>store: get the index from each endpoint
  store-->>shim: index copies
  shim->>store: get the release of each listed version
  store-->>shim: release copies
  shim-->>npm: packument with only verified versions
  npm->>shim: GET the tarball URL
  shim->>store: get the tarball
  store-->>shim: tarball copies
  shim-->>npm: tarball with the signed size and sha512
```

## Checks at install

npm asks the shim for 2 files: the packument (the list of versions) and the tarball of one version.

For the packument, the shim does these steps:

1. Parse the install name into the DID and the package name. Refuse a DID on the denylist in [SECURITY.md](../SECURITY.md).
2. Resolve the DID. The DID document gives the keys and the storage endpoints, the DWN endpoints first.
3. Get the index from each endpoint at the same time. Check each copy: the schema, the publisher, the name, and a signature by a key that is in `assertionMethod` now. The valid copy with the highest `sequence` wins.
4. Compare the winner with the pin for this DID and name (see [Pins](#pins)).
5. Get the release of each `active` and `deprecated` version, by the digest in the index. Check the signature and the fields of each release. If one release fails, the packument fails, so a host cannot hide one version.
6. Send the packument. It does not list `yanked` and `revoked` versions.

For the tarball, the shim does these steps:

1. Do steps 1 to 4 again, and get the release of the version.
2. Get the tarball from the endpoints in order. The first copy with the size and the sha512 of the signed release wins.
3. Make sure that the `package.json` in the tarball has the package name and the version.
4. If the URL has `rec` (from a lockfile), make sure that it is the digest of the signed release.

A failed check stops the install with an HTTP error. The [quickstart](quickstart.md#errors) gives each status.

## Trust model

You trust these parts:

- The publisher, and the keys in its DID document.
- The DID method:
  - A did:dht DID is a public key, and its DID document is a record that the key signs. A relay can hold back a record, but it cannot change a signed record.
  - A did:web DID is as safe as its web host: the person who controls the DNS name and the TLS certificate controls the DID.
  - A did:plc DID is the hash of its first signed operation. One directory (`plc.directory`) keeps the operation log of each DID. didpkg checks each signature in the log, but the directory can hold back an operation.
  - A did:btcr2 DID is a secp256k1 public key or the hash of its genesis document. Bitcoin transactions announce its updates. The shim gets the transactions from an Esplora API (`mempool.space`). It gets the genesis document and the updates from the Sidecar Data: the identity files of the publisher, a mirror that you set, or a copy of an earlier resolve. It gets the other items from IPFS through a gateway (`trustless-gateway.link`, then `ipfs.didpkg.dev`). You can set your own mirrors, gateways and Esplora APIs: see [the config file](cli.md#config-file). didpkg checks each hash and each signature. But the Esplora API can hold back a transaction, and a mirror or a gateway can hold back data.
- A XID and its XID document. A XID is the hash of its inception key, and the inception key signs each version of the XID document. Provenance marks give the order of the versions. A resolver can hold back a new version, but it cannot change a signed version. The shim keeps the newest version that it saw, and refuses an older version (`XID_ROLLBACK`).
- The didpkg CLI that you install, from npm or from GitHub.

You do not trust these parts:

- The storage endpoints (the DWN and the mirrors). They can stop, they can serve old files, or they can serve bad files. A bad file fails a digest check or a signature check.
- The network path to the storage endpoints.

A did:dht publisher has 2 keys. The release key `#didpkg-1` signs the index and the releases. The update key `#0` changes the DID document. The shim refuses an index or a release that `#0` signs, so the publisher can keep `#0` offline.

## Pins

The shim pins the first index that it accepts for each DID and package name. This is trust on first use (TOFU). A later index must obey these rules:

| Rule | Code if the rule fails |
|---|---|
| A new key must have a co-signature by a pinned key. | `KEY_CHANGED` |
| Each pinned release must stay in the index, with the same digest. | `HISTORY_CHANGED` |
| With the same key, the `sequence` must not go down. | `ROLLBACK` |
| An index with the pinned `sequence` must be the pinned index. | `EQUIVOCATION` |

`KEY_CHANGED` and `HISTORY_CHANGED` obey the mode. In `--mode warn`, the shim writes a warning to its log and installs the package. In the default mode (`enforce`), the shim refuses the package. All other codes refuse the package in each mode.

The shim keeps the pins in memory. When the shim stops, it forgets the pins.

## Limits

didpkg is experimental. It had no security audit. These limits apply:

1. Each shim start is a first use, because the pins are in memory only. On first use, the shim accepts each valid index. If the DWN is down, a stale mirror can serve an older valid index.
2. Only the `@didpkg` packages go through the shim. The dependencies of a `@didpkg` package come from your usual registry, and didpkg does not check them.
3. The shim does not find 2 valid index copies with the same `sequence` and different content at read time. The pin finds them later (`EQUIVOCATION`).
4. A cold DWN read of a packument with more than about 110 versions fails with 502. The cause is the request rate limit of the DWN reader.
5. A hash-form install name does not install, because didpkg has no DID binding for it. The [install-name grammar](spec/install-names.md) is draft 2 and can change before 1.0.

## More

- [Install names](spec/install-names.md): the grammar, the codec and the test vectors.
- [Release records](spec/release-records.md): the signed objects, the digests, the proofs and the storage layout.
- [ADR 0003](adr/0003-storage-contract.md): the storage contract, the DWN protocols v1 and v2, the static layout v1 and the packument rules.
- [Deploy a DWN](deploy.md): the runbook of the demo DWN.
- [SECURITY.md](../SECURITY.md): how to report a vulnerability, and the denylist.
