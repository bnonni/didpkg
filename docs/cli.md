# CLI reference

This page gives each command of `didpkg` 0.1.0. For the steps of a full task, read [Quickstart](quickstart.md) and [Publish a package](publish.md).

## Conventions

- The result goes to stdout. Messages and errors go to stderr, with the prefix `didpkg: error:`.
- The exit code is 0 if the command succeeds, else 1. A usage error also prints `Run "didpkg --help" for usage.`
- An option with a value can be in each position after the command. Give a repeatable option one time for each value.
- `-h` or `--help` after each command prints the full help.
- Each endpoint URL (`--dwn`, `--repo`, `--relay`, `--plc`, `--cas`, `--sidecar`, `--xid-resolver`, and the URLs in the [config file](#config-file)) must use `https`. `http` is permitted only on a loopback host (`127.0.0.1`, `localhost`, `[::1]`), for a local test.

## Environment

| Variable | Use |
|---|---|
| `DIDPKG_HOME` | The config folder. The identity files are in `$DIDPKG_HOME/ids`. The [config file](#config-file) is `$DIDPKG_HOME/config.json`. Default: `$XDG_CONFIG_HOME/didpkg`, else `~/.config/didpkg`. |
| `DIDPKG_PASSPHRASE` | The passphrase of the release key `#didpkg-1`, and of the release key and the DWN key of a XID publisher. If it is not set, didpkg asks in the terminal. |
| `DIDPKG_UPDATE_PASSPHRASE` | The passphrase of the update key (did:dht, did:webvh, did:plc and did:btcr2), and of the inception key of a XID publisher. If it is not set, didpkg asks in the terminal. |

The install script has its own variables: see [Install didpkg](install.md#environment-variables).

A new passphrase must have 12 or more characters. Without a terminal and without the variable, the command stops with `no passphrase: set <variable>, or run in a terminal`.

## didpkg name

```text
didpkg name <did|xid> <pkg-name>
```

Prints the install name for the DID or the XID and the package name. A XID is 64 lowercase hex characters, or a `ur:xid`. The `ur:xid` can hold a bare XID or a XID document, and the command does not verify the document.

```sh
didpkg name did:web:bnonni.github.io:didpkg-demo hello
didpkg name 71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c hello
didpkg name ur:xid/hdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnvsbyrdfw hello
```

```text
@didpkg/hello_did_web_bnonni.github.io_didpkg-demo
@didpkg/hello_xid_71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c
@didpkg/hello_xid_71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c
```

The package name must be 1 to 64 characters of `a-z`, `0-9`, `.` and `-`, and it must start with a letter or a digit. Else the error is `E_NAME: bad package name: <name>`. A XID with an uppercase letter gives `E_XID: a XID must be 64 lowercase hex characters`. A bad `ur:xid` gives `XID_INVALID`. The command does not resolve the DID, and it does not check the DID method. A package installs only from a did:dht or did:web DID, because only these DIDs have storage services. A XID name installs through the shim with a XID resolver ([`--xid-resolver`](#didpkg-shim-start)). `didpkg drl` takes a XID name with the same option.

## didpkg parse

```text
didpkg parse <install-name>
```

Prints the parts of an install name as one line of JSON.

```sh
didpkg parse @didpkg/hello_did_web_bnonni.github.io_didpkg-demo
```

```json
{"kind":"did","form":"direct","name":"hello","did":"did:web:bnonni.github.io:didpkg-demo"}
```

A hash-form name gives `{"kind":"did","form":"hash","name":...,"hash":...}`. A XID name gives `{"kind":"xid","form":"direct","name":...,"xid":...}`. A bad name gives a grammar error code, for example `E_SHAPE: no "_" separator` or `E_CANONICAL: name is not in canonical form`. A name without a kind segment `did` or `xid` gives `E_KIND`, for example `@didpkg/hello_dht_abc`. The codes are in [Install names](spec/install-names.md) section 6. The grammar is draft 2 and can change before 1.0.

## didpkg id create (did:dht)

```text
didpkg id create <alias> [--dwn <url>] [--repo <url>]... [--relay <url>]...
```

Makes a did:dht publisher DID with the release key `#didpkg-1` and the update key `#0`.

| Option | Default | Use |
|---|---|---|
| `--dwn <url>` | None | The DWN service `#dwn` (type `DecentralizedWebNode`). One time only. |
| `--repo <url>` | None | A mirror URL in the service `#pkg` (type `DIDPackageRepository`). Repeatable. |
| `--relay <url>` | `https://relay.pkarr.org`, `https://pkarr.pubky.org` | The Pkarr relays that get the DID record. Repeatable. |

The alias must be 1 to 63 characters of `a-z`, `0-9` and `-`. The command asks for 2 different passphrases: `DIDPKG_PASSPHRASE` and `DIDPKG_UPDATE_PASSPHRASE`.

1. It writes `<alias>.json` and `<alias>.update-key.json` in `$DIDPKG_HOME/ids`. It never replaces a file.
2. It sends the DID record to the relays.
3. If a relay accepts the DID, it installs the didpkg protocol on the DWN.

stdout gets the JSON result: `alias`, `did`, `keyId`, `files`, `relays` and `dwn`. stderr tells you to move the update key file offline. If no relay accepts the DID, or the protocol install fails, the exit code is 1, but the identity is saved. Then `didpkg publish` sends the DID and installs the protocol again. If the DWN needs a registration, the exit code is 0, and stderr tells you to run [`didpkg id register`](#didpkg-id-register).

## didpkg id create (did:web)

```text
didpkg id create <alias> --web <host>[:<path>]... [--dwn <url>] [--repo <url>]...
```

Makes a did:web publisher DID with the release key `#didpkg-1`, and the file `<alias>.did.json` to host.

| Option | Default | Use |
|---|---|---|
| `--web <id>` | None | The method-specific id: `<host>[%3A<port>][:<path>]...`. One time only. The host must be in lowercase. |
| `--dwn <url>` | None | The DWN service `#dwn`. One time only. |
| `--repo <url>` | None | A mirror URL in the service `#pkg`. Repeatable. |

`--relay` is not permitted with `--web`. The command asks for 1 passphrase: `DIDPKG_PASSPHRASE`. It does no network write.

stdout gets the JSON result: `alias`, `did`, `keyId`, `documentUrl` and `files`. stderr tells you to host `<alias>.did.json` at `documentUrl`. For the URL of each `--web` value, read [Publish a package](publish.md#didweb).

## didpkg id create (did:webvh)

```text
didpkg id create <alias> --webvh <host>[:<path>]... [--dwn <url>] [--repo <url>]...
```

Makes a did:webvh publisher DID with the release key `#didpkg-1` and an update key. It also makes 2 files to host: the DID log `<alias>.did.jsonl` and the parallel did:web document `<alias>.did.json`.

| Option | Default | Use |
|---|---|---|
| `--webvh <address>` | None | The address: `<host>[%3A<port>][:<path>]...`. One time only. The host must be in lowercase. didpkg adds the SCID. |
| `--dwn <url>` | None | The DWN service `#dwn`. One time only. |
| `--repo <url>` | None | A mirror URL in the service `#pkg`. Repeatable. |

`--relay` and `--web` are not permitted with `--webvh`. The command asks for 2 different passphrases: `DIDPKG_PASSPHRASE` and `DIDPKG_UPDATE_PASSPHRASE`. It does no network write.

stdout gets the JSON result: `alias`, `did`, `keyId`, `logUrl`, `documentUrl` and `files`. stderr tells you to host `<alias>.did.jsonl` at `logUrl` and `<alias>.did.json` at `documentUrl`, and to move the update key file offline. The address `nonni.org:pkgs` gives the URLs `https://nonni.org/pkgs/did.jsonl` and `https://nonni.org/pkgs/did.json`. An address with no path gives `https://<host>/.well-known/did.jsonl` and `https://<host>/.well-known/did.json`. Any static https host can serve the files, but the URLs must not redirect to another host. To change the services later, use [`didpkg id update`](#a-didwebvh-publisher).

The did.json is the parallel did:web DID that the did:webvh specification describes. The address `nonni.org:pkgs` gives `did:web:nonni.org:pkgs`. Its `alsoKnownAs` lists the did:webvh DID, and the did:webvh document lists the did:web DID. A did:web resolver can read the document, but it does not check the history of the log. didpkg install names use the did:webvh DID.

The host must send the header `Access-Control-Allow-Origin: *` with `did.jsonl`. The did:webvh specification makes this a requirement, so that a resolver in a web browser can read the log. The specification also recommends the content type `text/jsonl` for `did.jsonl`. The did:web specification recommends the same `Access-Control-Allow-Origin` header for `did.json`. Set these headers in the configuration of your static host.

A DWN accepts the writes of a did:webvh publisher only if the DWN resolves did:webvh. The stock `dwn-server` 0.1.45 resolves only did:dht, did:jwk, did:key and did:web. The didpkg DWN image also resolves did:webvh (see [deploy](deploy.md)), and `https://dwn.didpkg.dev` runs this image. If your DWN runs the stock `dwn-server`, use `didpkg publish --to dir:<path>` and a static host. To add a DWN to a did:webvh DID later, use [`didpkg id update`](#a-didwebvh-publisher).

## didpkg id create (did:plc)

```text
didpkg id create <alias> --plc <directory> [--dwn <url>] [--repo <url>]...
```

Makes a did:plc publisher DID with the release key `#didpkg-1` and a secp256k1 rotation key. Then it sends the signed genesis operation to the directory, with an HTTP POST to `<directory>/<did>`.

| Option | Default | Use |
|---|---|---|
| `--plc <directory>` | None | The directory URL, for example `https://plc.directory`. One time only. |
| `--dwn <url>` | None | A DWN endpoint: the service `#dwn` (type `DecentralizedWebNode`). One time only. |
| `--repo <url>` | None | A mirror URL. Repeatable. |

Give `--dwn`, `--repo` or both. The directory accepts a maximum of 10 services. A did:plc service has 1 URL. Thus each `--repo` URL gets a service: the first URL is `#pkg`, and the next URLs are `#pkg-2`, `#pkg-3` and so on.

`--relay`, `--web` and `--webvh` are not permitted with `--plc`. A DWN accepts the writes of a did:plc publisher only if the DWN resolves did:plc. The stock `dwn-server` 0.1.45 does not resolve did:plc. The didpkg DWN image resolves did:plc (see [deploy](deploy.md)), and `https://dwn.didpkg.dev` runs this image. If your DWN runs the stock `dwn-server`, use `didpkg publish --to dir:<path>` and a static host. To add a DWN to a did:plc DID later, use [`didpkg id update`](#a-didplc-publisher). The command asks for 2 different passphrases: `DIDPKG_PASSPHRASE` and `DIDPKG_UPDATE_PASSPHRASE`.

The rotation key is the update key of did:plc. It signs the genesis operation, and only this key can change the DID. The DID document does not show it: the operation log lists it in `rotationKeys`. The document shows `#didpkg-1` as a `Multikey`, and it has no `assertionMethod`. The didpkg verifier accepts a key with the fragment `#didpkg-<n>` as a release key of a did:plc DID. See rule 4 in [Proofs](spec/release-records.md#4-proofs).

stdout gets the JSON result: `alias`, `did`, `keyId`, `directory` and `files`. stderr tells you to move the update key file offline. If the directory does not accept the DID, the exit code is 1, but the identity is saved. Then run [`didpkg id register`](#didpkg-id-register) to send the operation again.

The directory keeps the operation log of each DID public. Nobody can delete a did:plc DID or its log.

## didpkg id create (did:btcr2)

```text
didpkg id create <alias> --btcr2 <network> [--dwn <url>] [--repo <url>]...
```

Makes a did:btcr2 publisher DID with the release key `#didpkg-1` and a secp256k1 update key `#initialKey`. The DID is an `x1` identifier: the hash of a Genesis Document. The command makes no Bitcoin transaction and no network request.

| Option | Default | Use |
|---|---|---|
| `--btcr2 <network>` | None | The Bitcoin network: `bitcoin`, `signet`, `regtest`, `testnet3`, `testnet4` or `mutinynet`. One time only. |
| `--dwn <url>` | None | A DWN endpoint: the service `#dwn` (type `DecentralizedWebNode`). One time only. |
| `--repo <url>` | None | A mirror URL in the service `#pkg`. Repeatable. |

Give `--dwn`, `--repo` or both. The services are in the Genesis Document, and a change to them needs a did:btcr2 update. `didpkg id update` does not do did:btcr2 updates. Thus, give all the services at create time.

A DWN must resolve the DID before it accepts a write. The didpkg DWN image (`deploy/dwn`) resolves did:btcr2. The stock `dwn-server` 0.1.45 does not.

`--relay`, `--web`, `--webvh` and `--plc` are not permitted with `--btcr2`. The command asks for 2 different passphrases: `DIDPKG_PASSPHRASE` and `DIDPKG_UPDATE_PASSPHRASE`.

The Genesis Document is the DID document with the placeholder id `did:btcr2:_`. It has these items:

- `#initialKey`: a secp256k1 `Multikey` in `capabilityInvocation`. The did:btcr2 specification permits only this key type to sign an update.
- `#didpkg-1`: an Ed25519 `Multikey` in `assertionMethod`.
- `#initialP2WPKH`: a `SingletonBeacon` service. Its address is the P2WPKH address of `#initialKey`. An update spends a UTXO of this address.
- `#dwn`: the `DecentralizedWebNode` service with the `--dwn` URL, with `--dwn` only.
- `#pkg`: the `DIDPackageRepository` service with the `--repo` URLs, with `--repo` only.

The command writes 2 more files in `$DIDPKG_HOME/ids`:

| File | Content |
|---|---|
| `<alias>.genesis.json` | The JCS bytes (RFC 8785) of the Genesis Document. The SHA-256 of the file is in the DID. |
| `<alias>.sidecar.json` | The Sidecar Data of the specification, with the Genesis Document. |

A resolver must have the Genesis Document, because the DID has only its hash. The shim gets it from one of these sources:

1. Sidecar Data. `didpkg publish --to dir:<path>` writes a copy of `<alias>.sidecar.json` to `<path>/<id>.sidecar.json`. `<id>` is the DID without `did:btcr2:`. Host the folder. A shim with [`--sidecar <URL of the folder>`](#didpkg-shim-start) reads the file.
2. CAS (IPFS). Put the genesis file in IPFS as a raw block. The CID in the result is the CIDv1 of that block. With Kubo, run `ipfs block put --cid-codec raw --mhtype sha2-256 --pin=true <alias>.genesis.json`. The shim then gets the block from the IPFS gateways (see [`--cas`](#didpkg-shim-start)).

The did:btcr2 specification recommends one of the two methods for the life of the DID. A DWN gets the Genesis Document only from IPFS. Thus, with `--dwn`, put the genesis file in IPFS before `didpkg publish --to dwn`.

stdout gets the JSON result: `alias`, `did`, `keyId`, `network`, `cid` and `files`. stderr tells you to move the update key file offline. It also gives the IPFS command and the name of the Sidecar Data file in the folder. With `--dwn`, it also tells you that the DWN reads the Genesis Document only from IPFS.

## didpkg id create (XID)

```text
didpkg id create <alias> --xid [--dwn <url>] [--repo <url>]...
```

Makes a XID publisher ([BCR-2024-010](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-010-xid.md)). The XID document is a Gordian Envelope. The inception key signs it. The document has these items:

- The inception key (nickname `inception`, `All`). The XID is the hash of this key. Only `didpkg id update` and `didpkg id backup` use it.
- The release key (nickname `release`, only `Sign`). It signs the release records and the indexes.
- The DWN key (nickname `dwn`, only `Auth`), with `--dwn` only. It signs the DWN messages.
- A provenance mark with `seq` 0. Each update adds the next mark.
- A service for each URL: the capability `DecentralizedWebNode` with the DWN key, and the capability `DIDPackageRepository` with the release key.
- A `dereferenceVia` URI for each `--repo` URL: `<url>/xid/<hex>.envelope`.

| Option | Default | Use |
|---|---|---|
| `--xid` | None | Make a XID publisher, not a DID. |
| `--dwn <url>` | None | A DWN endpoint. One time only. |
| `--repo <url>` | None | A mirror URL. Repeatable. |

`--relay`, `--web`, `--webvh`, `--plc` and `--btcr2` are not permitted with `--xid`. The command asks for 2 different passphrases: `DIDPKG_PASSPHRASE` and `DIDPKG_UPDATE_PASSPHRASE`. Each key and the provenance generator are locked with Argon2id, as bc-xid does it. The command does no network write.

The command writes 3 files in `$DIDPKG_HOME/ids`:

| File | Mode | Content |
|---|---|---|
| `<alias>.json` | 0600 | The signed XID document, and the release key and the DWN key, locked with `DIDPKG_PASSPHRASE`. |
| `<alias>.update-key.envelope` | 0600 | The XID document with the inception key and the provenance generator, locked with `DIDPKG_UPDATE_PASSPHRASE`. Move it offline. |
| `<alias>.xid.envelope` | 0644 | The signed XID document (tagged CBOR). Host it at each `dereferenceVia` URI. |

stdout gets the JSON result: `alias`, `xid` (64 hex characters), `ur` (the `ur:xid`), `seq`, `keys`, `documentUrls` and `files`.

```text
$ didpkg id create gordian --xid --repo https://pkgs.example.com/
$ didpkg name <xid> hello
@didpkg/hello_xid_<xid>
```

## didpkg id update

```text
didpkg id update <alias> [--rotate release|dwn]... [--dwn <url>] [--remove dwn] [--repo <url>]...
```

Changes the XID document of a XID publisher, or the services of a did:webvh or did:plc publisher. The command takes only a XID, did:webvh or did:plc identity.

For a XID, the command adds the next provenance mark, and the inception key signs the new document. It replaces the 3 files of [`id create --xid`](#didpkg-id-create-xid).

| Option | Use |
|---|---|
| `--rotate release` | Make a new release key, and remove the old key from the document. The identity file keeps the old key as `previousRelease`: on a key change, the index needs a signature by the old key too. |
| `--rotate dwn` | Make a new DWN key, and remove the old key. The DWN service gets the new key. |
| `--dwn <url>` | Set the DWN endpoint. If the document has no DWN key, add one. One time only. |
| `--remove dwn` | Remove the DWN service and the DWN key. |
| `--repo <url>` | Replace the mirror URLs and their `dereferenceVia` URIs. Repeatable. |

The command asks for `DIDPKG_UPDATE_PASSPHRASE`. A new key also needs `DIDPKG_PASSPHRASE`: the new key gets the passphrase of the release key. A wrong passphrase changes no file. stdout gets the same JSON result as `id create --xid`. Host the new `<alias>.xid.envelope` at each `dereferenceVia` URI.

### A did:webvh publisher

The command adds a new entry to the DID log `<alias>.did.jsonl`. The update key signs the entry. The entry changes only the services: the release key stays.

| Option | Use |
|---|---|
| `--dwn <url>` | Add the DWN service `#dwn`, or change its URL. One time only. |
| `--remove dwn` | Remove the service `#dwn`. |
| `--repo <url>` | Replace the mirror URLs of the service `#pkg`. Repeatable. |

`--rotate` is for a XID only. The command asks for `DIDPKG_UPDATE_PASSPHRASE`, and it does no network write. The local `<alias>.did.jsonl` is the base of the new entry. The command replaces `<alias>.did.jsonl`, `<alias>.did.json` and the identity file. A wrong passphrase changes no file.

stdout gets the JSON result: `alias`, `did`, `versionId` (the new entry), `logUrl`, `documentUrl` and `files`. Host the new `<alias>.did.jsonl` at `logUrl` and the new `<alias>.did.json` at `documentUrl`. A resolver reads the full log, thus each old entry must stay in the file.

### A did:plc publisher

The command sends an update operation to the directory, with an HTTP POST to `<directory>/<did>`. The rotation key signs the operation. The operation changes only the services: the release key and the rotation key stay.

| Option | Use |
|---|---|
| `--dwn <url>` | Add the DWN service `#dwn`, or change its URL. One time only. |
| `--remove dwn` | Remove the service `#dwn`. |
| `--repo <url>` | Replace the mirror URLs of the services `#pkg`, `#pkg-2` and so on. Repeatable. |

`--rotate` is for a XID only. The command asks for `DIDPKG_UPDATE_PASSPHRASE`. The `prev` value of the operation is the CID of the last operation in the identity file. Other services stay. The DID must keep a `#dwn` service or a `#pkg` service.

The command changes the identity file only after the directory accepts the operation. If the directory refuses it, the exit code is 1, and no file changes. If the reply of the directory is lost, run the same command again. Then the command finds the operation in the operation log of the directory.

stdout gets the JSON result: `alias`, `did`, `cid` (the new operation), `directory` and `files`. Resolvers show the new services immediately, and there is no file to host.

## didpkg id backup

```text
didpkg id backup <alias> --sskr <m>-of-<n>
```

Splits the private keys of a XID publisher into `n` shares with SSKR (Sharded Secret Key Reconstruction). Any `m` shares restore the identity; fewer shares tell nothing about the keys. `m` and `n` are 1 to 16, and `m` is not more than `n`. The command takes only a XID identity, and it asks for `DIDPKG_UPDATE_PASSPHRASE` and `DIDPKG_PASSPHRASE`.

The shares use Gordian Envelope SSKR. The backup is an envelope with the subject `didpkg-xid-backup` and these assertions:

| Predicate | Object |
|---|---|
| `created` | The `created` time of the identity file. |
| `document` | The XID document with the inception key and the provenance generator, not locked, signed by the inception key. |
| `release`, `dwn`, `previousRelease` | The envelope of each key that the identity has, with its private keys, not locked. |

A random symmetric key encrypts the wrapped backup. SSKR splits the symmetric key into one group of `m`-of-`n`. Each share is the encrypted backup with one `sskrShare` assertion. stdout gets one `ur:envelope` for each share, one share on each line.

Give each share to a different holder. A share holds the encrypted keys, thus keep each share as secret as a passphrase. The backup holds the document with its `seq` at backup time. Make a new backup after each [`didpkg id update`](#didpkg-id-update).

## didpkg id restore

```text
didpkg id restore <alias> <file>...
```

Makes the 3 files of [`id create --xid`](#didpkg-id-create-xid) again from the shares of [`id backup`](#didpkg-id-backup). Each file can hold one or more shares: each word that starts with `ur:envelope/` is a share. The command asks for 2 new passphrases, `DIDPKG_PASSPHRASE` and `DIDPKG_UPDATE_PASSPHRASE`, and locks the keys with them. It never replaces a file. stdout gets the same JSON result as `id create --xid`.

If a hosted XID document has a higher `seq` than the restored document, the backup is old. Do not run `didpkg id update` with an old backup: the next mark gets a `seq` that a hosted document has, and clients refuse the 2 documents (`XID_FORK`).

## didpkg id register

```text
didpkg id register <alias> [--dwn <url>] [--accept-terms <hash>]
```

Registers the DID of an identity as a tenant of a DWN. A DWN with registration accepts writes only from its tenants. `dwn.didpkg.dev` is a DWN with registration.

For a XID identity, the tenant is the `did:key` of the DWN key, and the DWN URL is the DWN service of the XID document. The command refuses a XID identity with no DWN service: run [`didpkg id update <alias> --dwn <url>`](#didpkg-id-update) first.

For a did:plc identity, the command first sends the genesis operation to the directory again. Use it if the directory did not accept the DID at `didpkg id create`. This step succeeds if the operation log of the directory has this operation. If the step fails, the command stops with exit code 1. Then, if the identity has a DWN service or you give `--dwn`, the command registers the DID on the DWN. The JSON result also has `directory`, the result of the first step. With no DWN, stdout gets only that result, and `--accept-terms` is not permitted.

For a did:btcr2 identity, the DWN URL is the `#dwn` service of the Genesis Document. The registration does not resolve the DID. Thus, this step does not need the genesis file in IPFS.

| Option | Default | Use |
|---|---|---|
| `--dwn <url>` | The URL of the `#dwn` service of the identity | The DWN for the registration. One time only. Necessary if the identity has no DWN URL or more than one. |
| `--accept-terms <hash>` | None | The SHA-256 hex of the terms of service that you accept. One time only. Use it in CI or with no terminal. |

The command asks for no passphrase. It sends no key and no signature.

1. It gets the terms of service of the DWN. If the DWN has no terms, it goes to step 3.
2. It shows the terms and their SHA-256 hash on stderr. On a terminal, it asks you to accept the terms (`y` or `N`). With `--accept-terms`, the hash must be equal to the hash of the terms.
3. It does the proof of work and shows the progress on stderr. At the server default, the average is about 16.8 million hashes (about 30 s).
4. It sends the registration to the DWN.

stdout gets the JSON result: `alias`, `did`, `dwn` and `termsOfServiceHash` (`null` if the DWN has no terms). The exit code is 1 if:

- You do not accept the terms.
- There is no terminal and no `--accept-terms`.
- The `--accept-terms` hash is not the hash of the terms. This occurs after a change of the terms. Read the new terms on stderr, then use the new hash.

To get the hash for CI, run the command one time with no terminal: `didpkg id register main < /dev/null`. stderr shows the terms and the hash. You can also hash the terms yourself: `curl -s https://dwn.didpkg.dev/registration/terms-of-service | sha256sum` (on macOS, `shasum -a 256`).

If you register again with the same terms, nothing changes. If the operator changes the terms, the DWN refuses your writes and the reads of your packages until you register again: `401 Agreed terms-of-service is outdated`. In that time, the shim reads your packages from the mirror. The registration does not prove that you control the DID. The DWN checks each write against the DID document.

After the registration, `didpkg publish` installs the didpkg protocol and writes.

## didpkg id show

```text
didpkg id show <alias>
```

Prints the public data of an identity as JSON: `alias`, `did`, `keyId`, `created`, `assertionMethod`, `service` and `files`. `files.updateKey` is `null` if the update key file is not in the folder. The command asks for no passphrase.

For a XID publisher, the JSON has `alias`, `kind` (`xid`), `xid`, `ur`, `created` and `provenance` (`seq`, `date`, `chainId`). It also has `keys` (`reference`, `nickname`, `allow`, `deny`, `inception`), `services`, `dereferenceVia` and `files`.

## didpkg publish

```text
didpkg publish <alias> <tarball> --to dwn|dir:<path>... [--relay <url>]...
```

Signs an `npm pack` tarball with the release key (`#didpkg-1` for a DID) and writes it to each target.

| Option | Default | Use |
|---|---|---|
| `--to dwn` | None | Write to each DWN URL of the identity: the `#dwn` service of a DID, or the DWN service of a XID document. |
| `--to dir:<path>` | None | Write the mirror files to a local folder. Repeatable. |
| `--relay <url>` | `https://relay.pkarr.org`, `https://pkarr.pubky.org` | The Pkarr relays that get the stored DID record again (did:dht only). Repeatable. |

`--to` is necessary at least one time. The command asks for `DIDPKG_PASSPHRASE` after it checks the tarball, the version and the targets.

stdout gets the JSON result: `did`, `name`, `version`, `installName`, `release`, `sequence`, `relays` and `targets`. If no relay accepts the DID, or one target fails, the exit code is 1. Run the same command again: it writes the same signed bytes. If the DID is not a tenant of the DWN, stderr tells you to run [`didpkg id register`](#didpkg-id-register).

The command refuses:

- A version with build metadata (`1.0.1+build.5`).
- A published version with a different tarball.
- `--to dwn` for an identity with no DWN service.

For the full steps and the errors, read [Publish a package](publish.md).

### A XID publisher

For a XID identity, the release and the index are signed Gordian Envelopes. The command:

- Refuses `--relay`.
- Writes the XID document to `<path>/xid/<hex>.envelope`, then `<name>/<version>.tgz`, `<name>/<version>.envelope` and `<name>/index.envelope`.
- With `--to dwn`, writes to the DWN service of the XID document. The tenant is the `did:key` of the DWN key, and the DWN key signs the DWN messages. The command installs the DWN protocol v2, then writes the tarball, the release and the index. The DWN does not get the XID document.
- Signs the index with the release key. After [`id update --rotate release`](#didpkg-id-update), it also signs the index with the previous release key. Thus a client with a pin on the old key accepts the new key.

Host the folder at a `--repo` URL of the identity. The XID document has a `dereferenceVia` URI for each `--repo` URL, so a shim with that URL in `--xid-resolver` finds the document. A shim needs the XID document also for a DWN, so host the document file at `xid/<hex>.envelope` on a static host. stdout gets `xid`, `name`, `version`, `installName`, `release`, `sequence` and `targets`.

## didpkg shim start

```text
didpkg shim start [--port <n>] [--relay <url>]... [--cas <url>]... [--sidecar <url>]... [--xid-resolver <url>]... [--mode enforce|warn] [--allow-loopback]
```

Starts the shim: an npm registry on `127.0.0.1` that verifies each `@didpkg` package before npm gets it.

| Option | Default | Use |
|---|---|---|
| `--port <n>` | `2092` | The port. `0` selects a free port. |
| `--relay <url>` | `https://relay.pkarr.org`, `https://pkarr.pubky.org` | The Pkarr relays that resolve a did:dht DID. Repeatable. |
| `--cas <url>` | `cas` of the [config file](#config-file), else `https://trustless-gateway.link` and `https://ipfs.didpkg.dev` | The IPFS gateways ([Trustless Gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/)) that give the genesis document and the update data of a did:btcr2 DID. The shim tries them in order. The next gateway gets a request if the gateway before it fails or gives no reply in 2 s. Repeatable. The options replace the `cas` list of the config file. |
| `--sidecar <url>` | `sidecar` of the [config file](#config-file), else none | A mirror of did:btcr2 Sidecar Data. For a DID, the shim gets `<url>/<id>.sidecar.json`, where `<id>` is the DID without `did:btcr2:`. The shim tries the mirrors in order. Repeatable. The options replace the `sidecar` list of the config file. |
| `--xid-resolver <url>` | `xid-resolver` of the [config file](#config-file), else none | A XID resolver. For a XID, the shim gets `<url>/xid/<hex>.envelope`. A static mirror of a XID publisher is a XID resolver. Repeatable. The options replace the `xid-resolver` list of the config file. See [XID documents](#xid-documents). |
| `--mode <mode>` | `enforce` | `warn` installs a package with a changed key or a changed release history, and writes a warning to the log. See [Pins](how-it-works.md#pins). |
| `--allow-loopback` | Off | Read DIDs, DWNs and mirrors on a loopback host. Only for tests and the local demo. This option has no value. |

The shim prints one JSON line to stdout, with the URL and the `.npmrc` line:

```json
{"url":"http://127.0.0.1:2092","npmrc":"@didpkg:registry=http://127.0.0.1:2092/"}
```

Then it writes one line for each request to stderr. It runs until SIGINT (Ctrl+C) or SIGTERM, and then exits with 0. If the port is in use, it exits with 1. For the HTTP errors of the shim, read [Quickstart](quickstart.md#errors).

### did:btcr2 Sidecar Data

The did:btcr2 specification does not tell how a resolver gets Sidecar Data. The shim uses the first of these sources that has the Sidecar Data of the DID:

1. The `<alias>.sidecar.json` file of the identity with this DID in `$DIDPKG_HOME/ids`. Thus a publisher can test an install before the first push.
2. The mirrors of `--sidecar`, in order.
3. The copy in `$DIDPKG_HOME/sidecar/`. After a resolve with no error, the shim keeps a copy of the mirror data there. Thus an install works when no mirror is available.

The mirrors come before the copy, so an old copy does not hide a new update. The shim gets each item that the Sidecar Data does not have from the IPFS gateways. For an `x1` DID, the Sidecar Data must have the Genesis Document with the hash of the DID. Else the shim does not use the source. The shim checks each hash and each signature. Thus a mirror can hold back data, but it cannot change data.

### XID documents

No public XID resolver exists. The shim gets the XID document from each `--xid-resolver` URL and from each `dereferenceVia` URI of its copy, in parallel. The valid document with the highest provenance sequence wins. The shim keeps that document in `$DIDPKG_HOME/xid/<hex>.envelope` and uses it for 1 minute. If no source gives a valid document, the shim uses the kept copy. A document with a lower sequence than the kept copy gives `XID_ROLLBACK`. The HTTP status of a XID error: `XID_NOT_FOUND` gives 404, `XID_UNAVAILABLE` and `XID_INVALID` give 502, and each other XID error gives 403.

### Config file

The shim and `didpkg drl` read `$DIDPKG_HOME/config.json` if the file exists. Each key is optional:

| Key | Default | Use |
|---|---|---|
| `cas` | `["https://trustless-gateway.link", "https://ipfs.didpkg.dev"]` | The IPFS gateways for did:btcr2, in order. `--cas` replaces this list. An empty list (`[]`) turns IPFS off: then the shim resolves only a did:btcr2 DID that needs no data from IPFS. |
| `sidecar` | `[]` | The Sidecar Data mirrors for did:btcr2, in order. `--sidecar` replaces this list. See [did:btcr2 Sidecar Data](#didbtcr2-sidecar-data). |
| `xid-resolver` | `[]` | The XID resolvers. `--xid-resolver` replaces this list. See [XID documents](#xid-documents). |
| `esplora` | `https://mempool.space/api` (`bitcoin`), `https://mempool.space/testnet/api` (`testnet3`), `https://mempool.space/testnet4/api` (`testnet4`), `https://mempool.space/signet/api` (`signet`), `https://mutinynet.com/api` (`mutinynet`) | The Esplora API for each Bitcoin network of did:btcr2. The keys are `bitcoin`, `testnet3`, `testnet4`, `signet`, `mutinynet` and `regtest`. A key replaces the default of its network. `regtest` has no default. |

Example:

```json
{
  "cas": ["https://ipfs.example.com", "https://trustless-gateway.link"],
  "esplora": { "testnet4": "https://esplora.example.com/testnet4/api" },
  "sidecar": ["https://pkgs.example.com/btcr2/"],
  "xid-resolver": ["https://pkgs.example.com/"]
}
```

An unknown key or a bad value stops the shim before it starts, with exit code 1.

## didpkg drl

```text
didpkg drl <install-name>[@<version>] [--relay <url>]... [--cas <url>]... [--sidecar <url>]... [--xid-resolver <url>]... [--allow-loopback]
```

Does the checks of the shim for one version. Then it prints the plain HTTPS URL of the signed tarball. npm, pnpm and bun can install the package from this URL with no shim and no `.npmrc` line. For the trade-off, read [Quickstart](quickstart.md#one-off-install-with-no-shim).

If you give no version, the command uses the `latest` dist-tag of the signed index. The options and the [config file](#config-file) are the same as for [didpkg shim start](#didpkg-shim-start).

The URL comes from the first endpoint that gives the signed tarball. The DWN endpoints come first:

- For a DWN, the URL is a DRL (Decentralized Resource Locator): `<dwn>/<did>/read/protocols/<protocol>/package/release/tarball?filter.contextId=<id>&filter.tags.version=<version>`. `<protocol>` is the base64url form of `https://didpkg.dev/protocols/repository/v1`. `<id>` is the `contextId` of the package record. For a XID publisher, `<did>` is the did:key of the DWN key, and the protocol is `https://didpkg.dev/protocols/repository/v2`.
- For a static mirror, the URL is `<repo>/<name>/<version>.tgz`.

The command prints JSON to stdout:

```json
{
  "did": "did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy",
  "name": "hello",
  "version": "1.0.0",
  "url": "https://dwn.didpkg.dev/did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy/read/protocols/aHR0cHM6Ly9kaWRwa2cuZGV2L3Byb3RvY29scy9yZXBvc2l0b3J5L3Yx/package/release/tarball?filter.contextId=bafyreibi24qfiffofl2nr6klm4zi4v4wylfrjfr2ru6f5h6mljd45z7zp4&filter.tags.version=1.0.0",
  "endpoint": "did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy#dwn",
  "integrity": "sha512-qa1JOuvzD6wPtfFBewB39/tlS3lMXHaiPukx1gT/9dkX+znRN2ZtZJsZkRw/4M5WjR5kG8BHx/gwkfsvmdTxkQ=="
}
```

`endpoint` is the service of the DID document that gave the tarball. For a XID name, the JSON has `xid` (64 hex characters) in place of `did`, and `endpoint` is the URI of the XID service. `integrity` is the sha512 of the signed release. Each policy warning goes to stderr. If a check fails, the command stops with exit code 1. The error gives the code of the check, for example `YANKED` or `INTEGRITY`. Thus a yanked version gives no URL.

## didpkg --help

```text
didpkg --help
```

Prints the help. `-h` and `help` do the same.

## didpkg --version

```text
didpkg --version
```

Prints the version, for example `0.1.0`. `-v` and `version` do the same.
