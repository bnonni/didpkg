# Publish a package

This guide makes a publisher DID, signs an npm package with its key and writes the package to storage. It takes about 15 minutes. For the parts and the checks at install, read [How didpkg works](how-it-works.md).

## Before you start

You must have:

- The didpkg CLI. See [Quickstart](quickstart.md), step 1.
- A package folder with a `package.json` file. The package name must be 1 to 64 characters of `a-z`, `0-9`, `.` and `-`, and it must start with a letter or a digit. A scope (`@me/lib`) and `_` are not permitted.
- Storage for the package, one or both of these:
  - A static HTTPS site that you control, for example a GitHub Pages repository. This is the mirror.
  - A DWN that accepts writes from your DID. The demo DWN `https://dwn.didpkg.dev` accepts only the DIDs that its operator adds. To run your own DWN, read [Deploy a DWN](deploy.md).

A DWN is optional. With only a mirror, the shim reads each package from the mirror.

## 1. Select a DID method

| | did:dht | did:web |
|---|---|---|
| DID document | On the Mainline DHT, through Pkarr relays | The file `did.json` on your HTTPS host |
| Control of the DID | The holder of the update key `#0` | The owner of the host and its DNS name |
| Keys that didpkg makes | The release key `#didpkg-1` and the update key `#0` | The release key `#didpkg-1` |
| Network write at `id create` | The DID record to the relays | None |
| Install name | `@didpkg/hello_dht_<52 characters>` | `@didpkg/hello_web_<host>_<path>` |

A did:web install name is short and easy to read. A did:dht DID needs no host and no DNS name.

## 2. Prepare the passphrases

didpkg encrypts each private key with a passphrase. A passphrase must have 12 or more characters. In a terminal, didpkg asks for each new passphrase 2 times.

For a script or CI, set the passphrases in the environment:

| Variable | Key | Used by |
|---|---|---|
| `DIDPKG_PASSPHRASE` | The release key `#didpkg-1` | `id create`, `publish` |
| `DIDPKG_UPDATE_PASSPHRASE` | The update key `#0` (did:dht only) | `id create` |

The 2 passphrases must be different. Keep them in a password manager. If you lose a passphrase, nobody can decrypt its key.

## 3. Make the identity

The alias is the local name of the identity. It has 1 to 63 characters of `a-z`, `0-9` and `-`.

### did:dht

```sh
didpkg id create main --dwn https://dwn.example.com --repo https://me.github.io/pkgs/
```

1. `--dwn <url>` adds the DWN service `#dwn`. Use it one time, or not at all.
2. `--repo <url>` adds a mirror URL to the service `#pkg`. Give it one time for each mirror.
3. `--relay <url>` sets the Pkarr relays. The default relays are `https://relay.pkarr.org` and `https://pkarr.pubky.org`.

The command writes the 2 key files first. Then it sends the DID record to the relays and installs the didpkg protocol on the DWN. It prints the DID and the file paths as JSON.

If no relay accepts the DID, or the DWN refuses the protocol, the command exits with 1. The identity is saved. The first `didpkg publish` sends the DID again and installs the protocol. A DWN with a tenant allowlist refuses a DID that is not a tenant: `401 Not a registered tenant`.

The DID record must have 1000 bytes or less. Each `--repo` and `--dwn` URL makes the record larger, so use a small number of short URLs.

### did:web

```sh
didpkg id create web --web me.github.io:pkgs --repo https://me.github.io/pkgs/
```

The command does no network write. It prints the URL of the DID document on stderr and in the JSON field `documentUrl`:

```text
Host /home/me/.config/didpkg/ids/web.did.json at https://me.github.io/pkgs/did.json. Then "didpkg publish" installs the DWN protocol.
```

Copy the file `web.did.json` to that URL as `did.json`. The `--web` value gives the URL:

| `--web` | DID | URL of `did.json` |
|---|---|---|
| `me.github.io` | `did:web:me.github.io` | `https://me.github.io/.well-known/did.json` |
| `me.github.io:pkgs` | `did:web:me.github.io:pkgs` | `https://me.github.io/pkgs/did.json` |
| `example.com%3A8443:pkgs` | `did:web:example.com%3A8443:pkgs` | `https://example.com:8443/pkgs/did.json` |

The host must be in lowercase. The site must use HTTPS. If you change the hosted `did.json` file, you change the DID document.

### One mirror for each publisher

Each publisher must have its own mirror URL, because the mirror path has no DID in it. If 2 publishers write to one URL, the second publish of the same version fails with `a different file exists`. For an example, see [didpkg-demo](https://github.com/bnonni/didpkg-demo): its root is the mirror of a did:dht publisher, and `web/` is the mirror of a did:web publisher.

## 4. Keep the key files safe

The files are in `$DIDPKG_HOME/ids`. If `DIDPKG_HOME` is not set, they are in `$XDG_CONFIG_HOME/didpkg/ids`, else in `~/.config/didpkg/ids`.

| File | Content | Mode | Action |
|---|---|---|---|
| `<alias>.json` | The DID document and the encrypted release key | `0600` | `didpkg publish` reads only this file. Make a backup copy. |
| `<alias>.update-key.json` | The encrypted update key `#0` (did:dht only) | `0600` | Move it offline. didpkg 0.1.0 does not use it. A future `didpkg id update` command will use it to change the DID document. |
| `<alias>.did.json` | The DID document to host (did:web only) | `0644` | Host it. See step 3. |

didpkg never replaces a key file. If the alias exists, `id create` stops with `<file> exists: didpkg never replaces a key`. didpkg 0.1.0 has no command to change a key. If you lose the release key, you cannot publish a new version with that DID.

## 5. Add the DID to the DWN

Do this step only if you publish to a DWN with a tenant allowlist. Get the DID:

```sh
didpkg id show main
```

Give the `did` value to the operator of the DWN. If you operate the DWN, read [Deploy a DWN](deploy.md), section 4.

For did:web, host `did.json` before the publish, because the DWN resolves the DID before it accepts a write.

## 6. Pack and publish

```sh
npm pack
didpkg publish main hello-1.0.0.tgz --to dwn --to dir:../pkgs
```

1. `--to dwn` writes to each DWN in the `#dwn` service of the identity.
2. `--to dir:<path>` writes the mirror files to a local folder. Give `--to` one time for each target.
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
  "did": "did:web:me.github.io:pkgs",
  "name": "hello",
  "version": "1.0.0",
  "installName": "@didpkg/hello_web_me.github.io_pkgs",
  "release": "sha256-adMqTpthgOM5QTg3UJsm7evplCFRKSemqfh3zfeh6nM=",
  "sequence": 1,
  "relays": [],
  "targets": [{ "url": "dir:../pkgs", "ok": true }]
}
```

`installName` is the name for `npm install`. `release` is the digest of the signed release. `sequence` is the number of the signed index.

A published version does not change:

- The same tarball again is safe. The command writes the same signed bytes, so it can repair a failed target.
- A different tarball with the same version fails with `hello@1.0.0 is published with a different tarball`. Increase the version.
- A version with build metadata, for example `1.0.1+build.5`, fails. SemVer ignores build metadata, so `1.0.1+a` and `1.0.1+b` are one version.

## 7. Push the mirror

The folder target gets 3 files for each package:

```text
hello/index.json      the signed index
hello/1.0.0.json      the signed release
hello/1.0.0.tgz       the tarball
```

Push the folder to the site at the `--repo` URL. Do not edit the files: the signatures cover them. On GitHub Pages, add an empty `.nojekyll` file to the root of the site.

## 8. Check the install

Use the `installName` from step 6 in [Quickstart](quickstart.md), steps 2 to 4:

```sh
npm install @didpkg/hello_web_me.github.io_pkgs
```

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

Mainline DHT nodes drop a did:dht record that nobody sends again. Each `didpkg publish` sends the record again. [ADR 0001](adr/0001-go-no-go.md) recorded no loss of the record in 24 hours.
