# didpkg

didpkg is a package manager with the DID (Decentralized Identifier) of the publisher as the root of trust. The publisher signs each release with a key from its DID document. The DWN (Decentralized Web Node) of the publisher is the registry. Static HTTPS mirrors hold the same signed bytes. Users install with plain npm, pnpm or bun, through a local shim that verifies each package before npm gets it.

## Status

Phase 1 (the first end-to-end demo) started on 2026-10-27, after the Gate 1 GO ([ADR 0001](docs/adr/0001-go-no-go.md)). Phase 1 exit criteria 1-4 pass (2026-10-28). The Gate 2 decision is open in [ADR 0002](docs/adr/0002-continue.md). The code is a demo, not a release. The npm package `didpkg@0.0.1` holds only the install-name codec.

The old drpm code is in the `legacy/*` tags, for example `legacy/v5.2.1`.

## Install

```sh
npm install --global didpkg
```

didpkg needs Node 22 or later. Note: `didpkg@0.1.0` is not on npm yet. Until then, build it from a clone ([quickstart, step 1](docs/quickstart.md#1-install-the-cli)).

To install a package by DID, start the shim. It runs until you push Ctrl+C.

```sh
didpkg shim start
```

In a second terminal, in your project folder, add 1 line to `.npmrc` and install:

```sh
echo '@didpkg:registry=http://127.0.0.1:2092/' >> .npmrc
npm install @didpkg/hello_web_bnonni.github.io_didpkg-demo
```

The [quickstart](docs/quickstart.md) gives each step and the HTTP errors.

## Documentation

The [docs index](docs/README.md) lists all documents. Start with these:

- [Quickstart](docs/quickstart.md): install the CLI, start the shim and install a package by DID.
- [How didpkg works](docs/how-it-works.md): the checks at install, the trust model and the limits.
- [Publish a package](docs/publish.md): make a publisher DID and publish a package.
- [CLI reference](docs/cli.md): each command and its options.

## Layout

| Path | npm name | Role |
|---|---|---|
| `packages/core` | `@didpkg/core` | `name/`: the install-name grammar (G1) and the shim request router. Phase 1 adds `did/`, `trust/` and `source/`. |
| `packages/adapter-https` | `@didpkg/adapter-https` | The static HTTPS mirror (`DIDPackageRepository`): the reader `httpsAdapter` and the `dir:` writer `DirWriter`, which also reads its folder back (ADR 0003 section 7). |
| `packages/adapter-dwn` | `@didpkg/adapter-dwn` | The publisher DWN (`DecentralizedWebNode`): the protocol v1, the reader `dwnAdapter` (with a rate limit per DWN origin) and the writer `DwnWriter` (ADR 0003 section 6). |
| `packages/cli` | `didpkg` | `didpkg name` and `didpkg parse` (from `didpkg@0.0.1`). `didpkg id create\|show`: a did:dht publisher DID, with the encrypted release key `#didpkg-1` and a separate update key file (`#0`). `didpkg id register`: accepts the terms of a DWN, then registers the DID there with a proof of work. `didpkg publish`: signs an `npm pack` tarball with `#didpkg-1` and writes the same bytes to the DWN and to `dir:` folders. `didpkg shim start`: the npm shim on 127.0.0.1, which verifies each packument and tarball before it serves them. |

## Develop

You must have Bun 1.4.4 or later.

```sh
bun install --ignore-scripts
bun test
bun run typecheck
```

The landing page for `didpkg.dev` is in `site/`: 1 HTML page, the CSS and the DWN protocol v1 definition. The build writes `site/dist`. The link check reads the site, the Markdown files and the GitHub URLs in the source. Each relative link and each anchor must have a target.

```sh
bun site/build.ts
bun site/check.ts
```

The standalone binaries for Linux and macOS (x64 and arm64) have the Bun runtime in them, thus a user needs no Bun and no Node. `packages/cli/compile.ts` builds all 4 on 1 machine. It writes `packages/cli/dist-bin`: 1 `.tar.gz` per target and `SHA256SUMS`. The workflow `release` tests each binary on a runner with its OS and CPU. A `v*` tag also makes the GitHub Release, with a build provenance attestation for each file.

```sh
bun packages/cli/compile.ts
```

The demo (`demo/e2e.ts`) starts a Pkarr relay, a `dwn-server` and a static mirror on 127.0.0.1. A did:dht publisher signs and publishes `demo/hello` to its DWN and to the mirror. A user with no keys then installs the package with npm, pnpm and bun through `didpkg shim start`. A did:web publisher (`did:web:web.didpkg.test`) hosts its `did.json` on a TLS site and publishes the same tarball to the same DWN and to that site, and npm installs it too. Then the DWN stops, and npm installs both packages from the mirrors. The demo makes a demo CA at run time, and a CONNECT proxy sends the did:web host to the TLS site (`demo/tls.ts`). The demo needs npm, Node, openssl and pnpm 11 or later.

```sh
bun demo/e2e.ts
```

The demo DWN (`dwn.didpkg.dev`) runs from the files in `deploy/`: the pinned `dwn-server` with a tenant allowlist, Traefik for TLS and the route allowlist, and a daily backup. The runbook is [docs/deploy.md](docs/deploy.md). The stack test starts the same files with a demo CA and a local relay. It needs Docker with Compose 2.24 or later, openssl and curl.

```sh
bun deploy/test/stack.ts
```

The live demo has 2 publishers. Both publish `hello@1.0.0` to `dwn.didpkg.dev` and to a mirror on GitHub Pages ([bnonni/didpkg-demo](https://github.com/bnonni/didpkg-demo)): `did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy` and `did:web:bnonni.github.io:didpkg-demo`. This command starts a shim with the public Pkarr relays, then installs both packages with npm, pnpm and bun:

```sh
bun demo/live.ts @didpkg/hello_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy @didpkg/hello_web_bnonni.github.io_didpkg-demo
```

## Security

See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
