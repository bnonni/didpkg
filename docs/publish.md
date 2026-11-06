# Publish a package

This guide makes a publisher DID with a DWN (Decentralized Web Node) in its DID document. Then it signs an npm package with a key of the DID and publishes the package to the DWN. The DWN is your registry. It takes about 15 minutes. For the parts and the checks at install, read [How didpkg works](how-it-works.md).

```text
didpkg id create  ->  a DID document with the release key #didpkg-1 and the DWN service #dwn
didpkg publish    ->  the signed release and the tarball, in the DWN
npm install       ->  the shim resolves the DID, reads the DWN and verifies the package
```

## Before you start

You must have:

- The didpkg CLI. See [Quickstart](quickstart.md), step 1.
- A package folder with a `package.json` file. The package name must be 1 to 64 characters of `a-z`, `0-9`, `.` and `-`, and it must start with a letter or a digit. A scope (`@me/lib`) and `_` are not permitted.
- A DWN that accepts writes from your DID. The demo DWN `https://dwn.didpkg.dev` accepts each DID that registers there (step 5). To run your own DWN, read [Deploy a DWN](deploy.md).

A static HTTPS mirror is optional. It is a backup copy of the same signed bytes. See [Optional backup mirror](#optional-backup-mirror).

## 1. Select a DID method

Each DID method that `didpkg id create` makes can have a DWN service. If you do not know which method to use, use did:dht. It needs no host and no DNS name. The steps of this guide use did:dht.


| | did:dht | did:web |
|---|---|---|
| DID document | On the Mainline DHT, through Pkarr relays | The file `did.json` on your HTTPS host |
| Control of the DID | The holder of the update key `#0` | The owner of the host and its DNS name |
| Keys that didpkg makes | The release key `#didpkg-1` and the update key `#0` | The release key `#didpkg-1` |
| Network write at `id create` | The DID record to the relays | None |
| Install name | `@didpkg/hello_did_dht_<52 characters>` | `@didpkg/hello_did_web_<host>_<path>` |

A did:web install name is short and easy to read. A did:dht DID needs no host and no DNS name.

didpkg also makes these DIDs:

- [did:webvh](#didwebvh): a did:web DID with a signed log of its changes, on your HTTPS host.
- [did:plc](#didplc): a DID in a PLC directory, for example `https://plc.directory`.
- [did:btcr2](#didbtcr2): a Bitcoin DID. The DID is the hash of a Genesis Document.
- [did:key and did:jwk](#didkey-and-didjwk): a DID that holds one public key. It cannot change, and it has no services. Each user of the package gives your DWN to the shim.

To publish with a XID in place of a DID, read [A XID publisher](#a-xid-publisher).

## 2. Prepare the passphrases

didpkg encrypts each private key with a passphrase. A passphrase must have 12 or more characters. In a terminal, didpkg asks for each new passphrase 2 times.

For a script or CI, set the passphrases in the environment:

| Variable | Key | Used by |
|---|---|---|
| `DIDPKG_PASSPHRASE` | The release key `#didpkg-1` | `id create`, `publish` |
| `DIDPKG_UPDATE_PASSPHRASE` | The update key of the DID (each method except did:web, did:key and did:jwk) | `id create`, `id update` |

The 2 passphrases must be different. Keep them in a password manager. If you lose a passphrase, nobody can decrypt its key. `didpkg id register` needs no passphrase.

## 3. Make the identity

The alias is the local name of the identity. It has 1 to 63 characters of `a-z`, `0-9` and `-`.

### did:dht

```sh
didpkg id create main --dwn https://dwn.didpkg.dev
```

1. `--dwn <url>` adds the DWN service `#dwn`. Use it one time.
2. `--repo <url>` (optional) adds a backup mirror URL to the service `#pkg`. Give it one time for each mirror. See [Optional backup mirror](#optional-backup-mirror).
3. `--relay <url>` sets the Pkarr relays. The default relays are `https://relay.pkarr.org` and `https://pkarr.pubky.org`.

The command writes the 2 key files first. Then it sends the DID record to the relays and installs the didpkg protocol on the DWN. It prints the DID and the file paths as JSON.

If no relay accepts the DID, or the DWN refuses the protocol, the command exits with 1. The identity is saved. The first `didpkg publish` sends the DID again and installs the protocol.

A DWN with registration refuses a DID that is not registered: `401 Not a registered tenant`. In this case, the command exits with 0 and shows the next command, `didpkg id register <alias>` (step 5).

The DID record must have 1000 bytes or less. Each `--repo` and `--dwn` URL makes the record larger, so use a small number of short URLs.

### did:web

```sh
didpkg id create web --web example.com:pkgs --dwn https://dwn.didpkg.dev
```

The command does no network write. It prints the URL of the DID document on stderr and in the JSON field `documentUrl`:

```text
Host /home/me/.config/didpkg/ids/web.did.json at https://example.com/pkgs/did.json. Then "didpkg publish" installs the DWN protocol.
```

Copy the file `web.did.json` to that URL as `did.json`. The `--web` value gives the URL:

| `--web` | DID | URL of `did.json` |
|---|---|---|
| `example.com` | `did:web:example.com` | `https://example.com/.well-known/did.json` |
| `example.com:pkgs` | `did:web:example.com:pkgs` | `https://example.com/pkgs/did.json` |
| `example.com%3A8443:pkgs` | `did:web:example.com%3A8443:pkgs` | `https://example.com:8443/pkgs/did.json` |

The host must be in lowercase. The site must use HTTPS. If you change the hosted `did.json` file, you change the DID document. The did:web specification recommends the header `Access-Control-Allow-Origin: *` for `did.json`, so that a resolver in a web browser can read it.

### did:webvh

```sh
didpkg id create vh --webvh example.com:pkgs --dwn https://dwn.didpkg.dev
```

The command makes the release key `#didpkg-1` and an update key. It asks for 2 different passphrases. It does no network write. It makes 2 files to host: the DID log `vh.did.jsonl` and the parallel did:web document `vh.did.json`. stderr shows the URL of each file, and the JSON fields `logUrl` and `documentUrl` give the same URLs:

| `--webvh` | URL of `did.jsonl` | URL of `did.json` |
|---|---|---|
| `example.com` | `https://example.com/.well-known/did.jsonl` | `https://example.com/.well-known/did.json` |
| `example.com:pkgs` | `https://example.com/pkgs/did.jsonl` | `https://example.com/pkgs/did.json` |

1. Copy the 2 files to these URLs. The URLs must not redirect to another host.
2. Set the header `Access-Control-Allow-Origin: *` for `did.jsonl`. The did:webvh specification makes this header a requirement. It also recommends the content type `text/jsonl`.
3. Move `vh.update-key.json` offline. Only `didpkg id update` needs it.

didpkg adds the SCID (self-certifying identifier) to the address. Thus the DID is `did:webvh:<SCID>:example.com:pkgs`. The install name has the SCID in lowercase and a [case mask](spec/install-names.md#3-the-fold-and-the-case-mask) for the uppercase letters. To get the install name, run `didpkg name <did> hello`.

The DWN must resolve did:webvh. The didpkg DWN image does, and `https://dwn.didpkg.dev` runs it. The stock `dwn-server` 0.1.45 does not.

To add or change the DWN later, run `didpkg id update vh --dwn <url>`. The command adds a signed entry to the log. Host the new `vh.did.jsonl` and `vh.did.json` again. The log must keep each old entry. See [the CLI reference](cli.md#a-didwebvh-publisher).

### did:plc

```sh
didpkg id create plc --plc https://plc.directory --dwn https://dwn.didpkg.dev
```

`--plc` is the URL of the PLC directory. `https://plc.directory` is the public directory. The command makes the release key `#didpkg-1` and a rotation key. It asks for 2 different passphrases. Then it sends the signed genesis operation to the directory. There is no file to host.

1. Give `--dwn`, `--repo` or both. The directory accepts a maximum of 10 services. Each `--repo` URL gets its own service: `#pkg`, `#pkg-2` and so on.
2. Move `plc.update-key.json` offline. It holds the rotation key. Only this key can change the DID.

The DID is `did:plc:<24 characters>`, and the install name is `@didpkg/hello_did_plc_<24 characters>`. The directory keeps the operation log of each DID public. Nobody can delete a did:plc DID or its log.

If the directory does not accept the DID, the command exits with 1. The identity is saved. In step 5, `didpkg id register plc` sends the operation again.

The DWN must resolve did:plc. The didpkg DWN image does, and `https://dwn.didpkg.dev` runs it. The stock `dwn-server` 0.1.45 does not.

To add or change the DWN later, run `didpkg id update plc --dwn <url>`. The command sends an update operation to the directory. See [the CLI reference](cli.md#a-didplc-publisher).

### did:btcr2

```sh
didpkg id create btc --btcr2 bitcoin --dwn https://dwn.didpkg.dev
```

The command does no network write and makes no Bitcoin transaction. With `--dwn <url>`, the Genesis Document gets the DWN service `#dwn`. The DWN must resolve did:btcr2 (the didpkg DWN image does), and it gets the Genesis Document only from IPFS (method 2). Without `--dwn`, publish with `--to dir:<path>` only. The DID is the hash of a Genesis Document. A resolver must have this document. Use one of these methods to give it:

1. Sidecar Data. `didpkg publish --to dir:<path>` writes the file `<id>.sidecar.json` to the root of the folder. `<id>` is the DID without `did:btcr2:`. Push the folder to the mirror site (see [Optional backup mirror](#optional-backup-mirror)). Each user of the package must start the shim with `--sidecar <URL of the folder>`, or put the URL in the `sidecar` list of the [config file](cli.md#config-file).
2. CAS (IPFS). Put the file `btc.genesis.json` in IPFS as a raw block, and keep it pinned. The shim gets the block through an IPFS gateway (default: `trustless-gateway.link`, then `ipfs.didpkg.dev`). With Kubo:

```sh
ipfs block put --cid-codec raw --mhtype sha2-256 --pin=true ~/.config/didpkg/ids/btc.genesis.json
```

The CID in the output must be the `cid` of the `id create` result. Other IPFS nodes must get the block from your node, so your node must accept connections on its swarm port (Kubo: 4001). Make sure that a public gateway gives the block:

```sh
curl -sf -H 'Accept: application/vnd.ipld.raw' 'https://trustless-gateway.link/ipfs/<cid>?format=raw' | sha256sum
```

The hash must be the SHA-256 of the genesis file. The did:btcr2 specification recommends one method for the life of the DID.

### did:key and did:jwk

```sh
didpkg id create pk --key --dwn https://dwn.didpkg.dev
```

For a did:jwk DID, use `--jwk` in place of `--key`. The DID holds the public key of the release key (Ed25519). The command makes only `pk.json`, with no update key, and it does no network write. Nobody can change the DID. For a new key or a new DWN, make a new identity.

The DID document has no services, so a shim cannot find your DWN from the DID. Thus:

1. Publish only to the DWN (`--to dwn`). A backup mirror has no use, because a shim cannot find it.
2. Give the DWN URL to each user of the package. The user starts the shim with `didpkg shim start --dwn https://dwn.didpkg.dev`, or puts the URL in the `dwn` list of the [config file](cli.md#config-file).

The install name has the DID in lowercase and a case mask, for example `@didpkg/hello_did_key.ixcqfxbqq_z6mkhaxgbzdvotdkl5257faiztigic2qtklgpbnnegta2dok`. To get it, run `didpkg name <did> hello`. The stock `dwn-server` 0.1.45 also resolves did:key and did:jwk.

## 4. Keep the key files safe

The files are in `$DIDPKG_HOME/ids`. If `DIDPKG_HOME` is not set, they are in `$XDG_CONFIG_HOME/didpkg/ids`, else in `~/.config/didpkg/ids`.

| File | Content | Mode | Action |
|---|---|---|---|
| `<alias>.json` | The DID document and the encrypted release key | `0600` | `didpkg publish` reads only this file. Make a backup copy. |
| `<alias>.update-key.json` | The encrypted update key of the DID (each method except did:web, did:key and did:jwk) | `0600` | Move it offline. You need it to change the DID document. `didpkg id update` uses it for did:webvh and did:plc. |
| `<alias>.did.json` | The DID document to host (did:web), or the parallel did:web document (did:webvh) | `0644` | Host it. See step 3. |
| `<alias>.did.jsonl` | The DID log to host (did:webvh only) | `0644` | Host it. See [did:webvh](#didwebvh). |
| `<alias>.genesis.json` | The JCS bytes of the Genesis Document (did:btcr2 only) | `0644` | Put it in IPFS as a raw block. See [the CLI reference](cli.md#didpkg-id-create-didbtcr2). |
| `<alias>.sidecar.json` | The Sidecar Data with the Genesis Document (did:btcr2 only) | `0644` | Keep it. `didpkg publish --to dir:` writes a copy to the folder. See [did:btcr2](#didbtcr2). |

didpkg never replaces a key file. If the alias exists, `id create` stops with `<file> exists: didpkg never replaces a key`. didpkg 0.1.0 has no command to change a key. If you lose the release key, you cannot publish a new version with that DID.

## 5. Register the DID on the DWN

Do this step only if you publish to a DWN with registration, for example `https://dwn.didpkg.dev`:

```sh
didpkg id register main
```

1. The command shows the terms of service of the DWN and their SHA-256 hash. Read the terms.
2. In a terminal, type `y` to accept the terms. In a script or CI, use `--accept-terms <hash>`.
3. The command does a proof of work. On the demo DWN, it takes about 30 s on average.

If the identity has no `#dwn` service, add `--dwn <url>`. For all options, read [CLI reference](cli.md#didpkg-id-register).

If the operator changes the terms, the DWN refuses your writes and the reads of your packages: `401 Agreed terms-of-service is outdated`. Run `didpkg id register main` again. Until then, the shim reads your packages only from a backup mirror, if you have one.

A DWN with a tenant allowlist and no registration accepts only the DIDs that its operator adds. Give the `did` value of `didpkg id show main` to the operator.

For did:web, host `did.json` before the publish, because the DWN resolves the DID before it accepts a write. For did:webvh, host `did.jsonl` and `did.json` before the publish for the same reason.

## 6. Pack and publish

```sh
npm pack
didpkg publish main hello-1.0.0.tgz --to dwn
```

1. `--to dwn` writes to each DWN in the `#dwn` service of the identity. For did:key and did:jwk, it writes to each DWN of the `--dwn` option of `id create`.
2. `--to dir:<path>` (optional) writes the files of a backup mirror to a local folder. See [Optional backup mirror](#optional-backup-mirror). Give `--to` one time for each target.
3. `--relay <url>` sets the Pkarr relays for a did:dht identity.

The command does these steps:

1. It checks the tarball, the version and the targets. Then it asks for the release key passphrase.
2. For did:dht, it sends the stored DID record to the relays again. Then it installs the protocol on each DWN.
3. It reads the index and the release of the version from each target. If one read fails, it signs nothing and writes nothing.
4. It signs the release and the next index with `#didpkg-1`.
5. It writes the same bytes to each target: first the DWN, then each folder. A failed target does not stop the other targets.

The output is JSON:

```json
{
  "did": "did:web:example.com:pkgs",
  "name": "hello",
  "version": "1.0.0",
  "installName": "@didpkg/hello_did_web_example.com_pkgs",
  "release": "sha256-adMqTpthgOM5QTg3UJsm7evplCFRKSemqfh3zfeh6nM=",
  "sequence": 1,
  "relays": [],
  "targets": [{ "url": "https://dwn.didpkg.dev", "ok": true }]
}
```

`installName` is the name for `npm install`. `release` is the digest of the signed release. `sequence` is the number of the signed index.

A published version does not change:

- The same tarball again is safe. The command writes the same signed bytes, so it can repair a failed target.
- A different tarball with the same version fails with `hello@1.0.0 is published with a different tarball`. Increase the version.
- A version with build metadata, for example `1.0.1+build.5`, fails. SemVer ignores build metadata, so `1.0.1+a` and `1.0.1+b` are one version.

## 7. Check the install

Use the `installName` from step 6 in [Quickstart](quickstart.md), steps 2 to 4:

```sh
npm install @didpkg/hello_did_web_example.com_pkgs
```

## Optional backup mirror

A mirror is a static HTTPS site that holds a backup copy of the same signed bytes as the DWN. The shim reads the DWN and each mirror. If the DWN is down, the shim installs from a mirror. A mirror is not necessary, except for a [XID publisher](#a-xid-publisher).

1. Add the mirror URL to the DID document with `--repo <url>` at `id create`. For did:dht, each URL makes the DID record larger (step 3).

   ```sh
   didpkg id create main --dwn https://dwn.didpkg.dev --repo https://pkgs.example.com/
   ```

2. Publish to the DWN and to a local folder:

   ```sh
   didpkg publish main hello-1.0.0.tgz --to dwn --to dir:../pkgs
   ```

3. Copy the folder to the site at the `--repo` URL. Any static HTTPS host can serve it: a VPS, a home server, Netlify or GitHub Pages. Do not edit the files: the signatures cover them. If the host runs Jekyll (GitHub Pages does by default), add an empty `.nojekyll` file to the root of the site.

The folder gets 3 files for each package:

```text
hello/index.json      the signed index
hello/1.0.0.json      the signed release
hello/1.0.0.tgz       the tarball
```

A did:btcr2 publisher also gets the file `<id>.sidecar.json` in the root of the folder. Each publish writes it again.

Each publisher must have its own mirror URL, because the mirror path has no DID in it. If 2 publishers write to one URL, the second publish of the same version fails with `a different file exists`. For example, the did:web, did:plc and did:btcr2 demo publishers use the mirrors `https://nonni.org/pkgs/web/`, `https://nonni.org/pkgs/plc/` and `https://nonni.org/pkgs/btcr2/`.

You can also publish to a mirror with no DWN. Make the identity with `--repo` and no `--dwn`, then publish with `--to dir:<path>` only.

## A XID publisher

A XID publisher uses a XID ([BCR-2024-010](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2024-010-xid.md)) in place of a DID. The steps above apply, with these changes:

1. Make the identity with `--xid`. The command does no network write.

   ```sh
   didpkg id create gordian --xid --dwn https://dwn.example.com --repo https://pkgs.example.com/
   ```

2. Keep the key files safe. `DIDPKG_PASSPHRASE` locks the release key and the DWN key. `DIDPKG_UPDATE_PASSPHRASE` locks the inception key in `gordian.update-key.envelope`. Move that file offline. For a backup of all keys, use [`didpkg id backup gordian --sskr 2-of-3`](cli.md#didpkg-id-backup).
3. Register on the DWN: `didpkg id register gordian`. The tenant is the `did:key` of the DWN key, not the XID.
4. Publish to the DWN and to the mirror folder:

   ```sh
   didpkg publish gordian hello-1.0.0.tgz --to dwn --to dir:../pkgs
   ```

5. Push the mirror. The folder gets `xid/<hex>.envelope` (the XID document), `hello/index.envelope`, `hello/1.0.0.envelope` and `hello/1.0.0.tgz`. The DWN does not hold the XID document. Thus a XID publisher must have a static mirror, also with a DWN.
6. Check the install. A XID name has no host, so the shim must get the mirror URL as a XID resolver:

   ```sh
   didpkg shim start --xid-resolver https://pkgs.example.com/
   npm install @didpkg/hello_xid_<hex>
   ```

Tell your users the mirror URL. They can also put it in the `xid-resolver` list of the [config file](cli.md#config-file). After each [`didpkg id update`](cli.md#didpkg-id-update), copy the new `gordian.xid.envelope` to `xid/<hex>.envelope` in the mirror. A publish to the folder also writes it. Then push the mirror again.

## Publish from CI

1. Put the passphrase in the CI secret `DIDPKG_PASSPHRASE`.
2. Put the file `<alias>.json` in a CI secret. Write it to `$DIDPKG_HOME/ids/` before the publish.
3. Never put the update key file in CI.

## Errors

The command exits with 1 for each error. If one target fails, the other targets have the package.

| Message | Cause | Action |
|---|---|---|
| `no passphrase: set DIDPKG_PASSPHRASE, or run in a terminal` | No terminal and no variable. | Set `DIDPKG_PASSPHRASE`. |
| `<key>: wrong passphrase, or the keyfile changed` | The passphrase does not decrypt the key. | Use the passphrase of this identity. |
| `--to dwn: the identity has no DecentralizedWebNode service` | The identity has no `--dwn` URL. | Use `--to dir:<path>` only, or make an identity with `--dwn`. |
| `no relay accepted the DID` | The relays are down, or the network is down. | Run the same publish again. |
| `<target> failed` | One target refused the write. The JSON gives the error. | Fix the cause, then run the same publish again. |
| `<name>@<version> is published with a different tarball` | The version exists with other bytes. | Increase the version. |
| `<version>: a version with build metadata is not published` | The version has a `+` part. | Remove the `+` part. |

Mainline DHT nodes drop a did:dht record that nobody sends again. Each `didpkg publish` sends the record again.
