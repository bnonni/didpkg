# Quickstart

This guide installs the didpkg CLI, starts the shim and installs a demo package by its DID. It takes about 5 minutes.

## Before you start

You must have:

- Node 22 or later, with npm.
- A project folder with a `package.json` file (`npm init -y` makes one).

## 1. Install the CLI

```sh
npm install --global didpkg
didpkg --version
```

The version must be `0.1.0` or later. Note: `didpkg@0.1.0` is not on npm yet. Until then, build the package from a clone. The build needs Bun 1.4.4 or later. The package that you install needs only Node.

```sh
git clone https://github.com/bnonni/didpkg.git
cd didpkg
bun install --ignore-scripts
cd packages/cli
npm pack
npm install --global ./didpkg-0.1.0.tgz
```

## 2. Start the shim

```sh
didpkg shim start
```

The shim is a small npm registry on `127.0.0.1`, port 2092. It verifies each package before npm gets it. It prints one JSON line, then runs until you push Ctrl+C:

```json
{"url":"http://127.0.0.1:2092","npmrc":"@didpkg:registry=http://127.0.0.1:2092/"}
```

The shim writes one log line for each request to stderr. Keep this terminal open, and use a second terminal for the next steps.

| Option | Default | Use |
|---|---|---|
| `--port <n>` | `2092` | Use a different port. Then use the same port in `.npmrc`. |
| `--relay <url>` | `https://relay.pkarr.org` and `https://pkarr.pubky.org` | The Pkarr relays that resolve a did:dht DID. Give the option one time for each relay. |
| `--mode warn` | `enforce` | Install a package with a changed key or a changed release history, and write a warning to the log. See [Pins](how-it-works.md#pins). |

The option `--allow-loopback` is only for tests and the local demo.

## 3. Send the @didpkg scope to the shim

Add this line to the `.npmrc` file in your project folder:

```ini
@didpkg:registry=http://127.0.0.1:2092/
```

npm sends only the `@didpkg` packages to the shim. All other packages come from your usual registry.

## 4. Install a package by DID

```sh
npm install @didpkg/hello_web_bnonni.github.io_didpkg-demo
node -e "console.log(require('@didpkg/hello_web_bnonni.github.io_didpkg-demo'))"
```

The second command prints `hello from didpkg`. The publisher of this package is `did:web:bnonni.github.io:didpkg-demo`. The same package from a did:dht publisher is:

```sh
npm install @didpkg/hello_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy
```

pnpm and bun read the same `.npmrc` line. The demo tests pnpm 11 and Bun 1.4.4.

```sh
pnpm add @didpkg/hello_web_bnonni.github.io_didpkg-demo
bun add @didpkg/hello_web_bnonni.github.io_didpkg-demo
```

## 5. Read an install name

An install name holds the package name and the DID of the publisher:

```sh
didpkg parse @didpkg/hello_web_bnonni.github.io_didpkg-demo
```

```json
{"form":"direct","name":"hello","did":"did:web:bnonni.github.io:didpkg-demo"}
```

This command gives the install name for a DID and a package name:

```sh
didpkg name did:web:bnonni.github.io:didpkg-demo hello
```

The install-name grammar is draft 1 and can change before 1.0.

## Lockfiles and CI

The lockfile holds the shim URL of each `@didpkg` tarball, for example:

```text
http://127.0.0.1:2092/@didpkg/hello_web_bnonni.github.io_didpkg-demo/-/hello_web_bnonni.github.io_didpkg-demo-1.0.0.tgz?rec=sha256-Dd0%2BYq5r...&vm=did%3Aweb%3Abnonni.github.io%3Adidpkg-demo%23didpkg-1
```

1. Start the shim on the same port before each install from the lockfile, also before `npm ci` in CI.
2. The value `rec` is the digest of the signed release. If the publisher changes the signed release of that version, the shim refuses the tarball (`HISTORY_CHANGED`, 403).

## Errors

The shim answers npm with an HTTP status and a reason. npm shows the reason in its error line, and the shim log shows the same reason:

```text
npm error 404 Not Found - GET http://127.0.0.1:2092/@didpkg%2fnope_web_bnonni.github.io_didpkg-demo - INDEX_MISSING: no index for did:web:bnonni.github.io:didpkg-demo/nope
```

| Status | Cause | Action |
|---|---|---|
| 400 | The install name does not follow the grammar, or the path has a bad character. Also: a request target that is not a path (`bad request target`), for example from a proxy client. | Check the name with `didpkg parse`. Use the shim only as a registry URL, not as a proxy. |
| 403 | A signature, a digest or the release history does not verify. The reason gives the code, for example `INDEX_SIGNATURE`, `INTEGRITY`, `KEY_CHANGED` or `ROLLBACK`. A DID on the denylist in [SECURITY.md](../SECURITY.md) also gives 403. | Do not install the package. Ask the publisher. For `KEY_CHANGED` and `HISTORY_CHANGED`, read [Pins](how-it-works.md#pins). |
| 404 | The DID, the package or the version is not found. Codes: `INDEX_MISSING`, `NOT_LISTED`, `MANIFEST_MISSING`, `TARBALL_MISSING`, `NOT_FOUND`, `METHOD_NOT_SUPPORTED`. A hash-form install name also gives 404 (Phase 2). | Check the install name with `didpkg parse`. Ask the publisher for the correct name. |
| 405 | A method other than `GET` or `HEAD`, for example `npm publish`. The shim does not publish. | Publish with `didpkg publish`. |
| 421 | The `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (`bad host`). | Use `127.0.0.1` or `localhost` in `.npmrc`. Do not use a LAN address or another host name. |
| 502 | The DID did not resolve, no endpoint gave a usable copy (`UNAVAILABLE`), or no copy has the signed digest (`MISMATCH`). npm tries again before it stops. | Try again later. Make sure that the network is up. For did:dht, make sure that the `--relay` URLs work. |
| 500 | A defect in didpkg. | Report it in [GitHub issues](https://github.com/bnonni/didpkg/issues). |

## Next

- [How didpkg works](how-it-works.md): the parts, the checks at install, the trust model and the limits.
- All commands: `didpkg --help`.
