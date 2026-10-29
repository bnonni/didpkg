# CLI reference

This page gives each command of `didpkg` 0.1.0. For the steps of a full task, read [Quickstart](quickstart.md) and [Publish a package](publish.md).

## Conventions

- The result goes to stdout. Messages and errors go to stderr, with the prefix `didpkg: error:`.
- The exit code is 0 if the command succeeds, else 1. A usage error also prints `Run "didpkg --help" for usage.`
- An option with a value can be in each position after the command. Give a repeatable option one time for each value.
- `-h` or `--help` after each command prints the full help.
- Each endpoint URL (`--dwn`, `--repo`, `--relay`) must use `https`. `http` is permitted only on a loopback host (`127.0.0.1`, `localhost`, `[::1]`), for a local test.

## Environment

| Variable | Use |
|---|---|
| `DIDPKG_HOME` | The config folder. The identity files are in `$DIDPKG_HOME/ids`. Default: `$XDG_CONFIG_HOME/didpkg`, else `~/.config/didpkg`. |
| `DIDPKG_PASSPHRASE` | The passphrase of the release key `#didpkg-1`. If it is not set, didpkg asks in the terminal. |
| `DIDPKG_UPDATE_PASSPHRASE` | The passphrase of the update key `#0` (did:dht only). If it is not set, didpkg asks in the terminal. |

A new passphrase must have 12 or more characters. Without a terminal and without the variable, the command stops with `no passphrase: set <variable>, or run in a terminal`.

## didpkg name

```text
didpkg name <did> <pkg-name>
```

Prints the install name for the DID and the package name.

```sh
didpkg name did:web:bnonni.github.io:didpkg-demo hello
```

```text
@didpkg/hello_web_bnonni.github.io_didpkg-demo
```

The package name must be 1 to 64 characters of `a-z`, `0-9`, `.` and `-`, and it must start with a letter or a digit. Else the error is `E_NAME: bad package name: <name>`. The command does not resolve the DID, and it does not check the DID method. A package installs only from a did:dht or did:web DID, because only these DIDs have storage services.

## didpkg parse

```text
didpkg parse <install-name>
```

Prints the parts of an install name as one line of JSON.

```sh
didpkg parse @didpkg/hello_web_bnonni.github.io_didpkg-demo
```

```json
{"form":"direct","name":"hello","did":"did:web:bnonni.github.io:didpkg-demo"}
```

A hash-form name gives `{"form":"hash","name":...,"hash":...}`. A bad name gives a grammar error code, for example `E_SHAPE: no "_" separator` or `E_CANONICAL: name is not in canonical form`. The grammar is draft 1 and can change before 1.0.

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

stdout gets the JSON result: `alias`, `did`, `keyId`, `files`, `relays` and `dwn`. stderr tells you to move the update key file offline. If no relay accepts the DID, or the protocol install fails, the exit code is 1, but the identity is saved. Then `didpkg publish` sends the DID and installs the protocol again.

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

## didpkg id show

```text
didpkg id show <alias>
```

Prints the public data of an identity as JSON: `alias`, `did`, `keyId`, `created`, `assertionMethod`, `service` and `files`. `files.updateKey` is `null` if the update key file is not in the folder. The command asks for no passphrase.

## didpkg publish

```text
didpkg publish <alias> <tarball> --to dwn|dir:<path>... [--relay <url>]...
```

Signs an `npm pack` tarball with `#didpkg-1` and writes it to each target.

| Option | Default | Use |
|---|---|---|
| `--to dwn` | None | Write to each DWN URL in the `#dwn` service of the identity. |
| `--to dir:<path>` | None | Write the mirror files to a local folder. Repeatable. |
| `--relay <url>` | `https://relay.pkarr.org`, `https://pkarr.pubky.org` | The Pkarr relays that get the stored DID record again (did:dht only). Repeatable. |

`--to` is necessary at least one time. The command asks for `DIDPKG_PASSPHRASE` after it checks the tarball, the version and the targets.

stdout gets the JSON result: `did`, `name`, `version`, `installName`, `release`, `sequence`, `relays` and `targets`. If no relay accepts the DID, or one target fails, the exit code is 1. Run the same command again: it writes the same signed bytes.

The command refuses:

- A version with build metadata (`1.0.1+build.5`).
- A published version with a different tarball.
- `--to dwn` for an identity with no DWN service.

For the full steps and the errors, read [Publish a package](publish.md).

## didpkg shim start

```text
didpkg shim start [--port <n>] [--relay <url>]... [--mode enforce|warn] [--allow-loopback]
```

Starts the shim: an npm registry on `127.0.0.1` that verifies each `@didpkg` package before npm gets it.

| Option | Default | Use |
|---|---|---|
| `--port <n>` | `2092` | The port. `0` selects a free port. |
| `--relay <url>` | `https://relay.pkarr.org`, `https://pkarr.pubky.org` | The Pkarr relays that resolve a did:dht DID. Repeatable. |
| `--mode <mode>` | `enforce` | `warn` installs a package with a changed key or a changed release history, and writes a warning to the log. See [Pins](how-it-works.md#pins). |
| `--allow-loopback` | Off | Read DIDs, DWNs and mirrors on a loopback host. Only for tests and the local demo. This option has no value. |

The shim prints one JSON line to stdout, with the URL and the `.npmrc` line:

```json
{"url":"http://127.0.0.1:2092","npmrc":"@didpkg:registry=http://127.0.0.1:2092/"}
```

Then it writes one line for each request to stderr. It runs until SIGINT (Ctrl+C) or SIGTERM, and then exits with 0. If the port is in use, it exits with 1. For the HTTP errors of the shim, read [Quickstart](quickstart.md#errors).

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
