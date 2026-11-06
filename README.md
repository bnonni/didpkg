# didpkg

didpkg is a package manager with the DID (Decentralized Identifier) of the publisher as the root of trust. The idea is simple: put a DWN (Decentralized Web Node) in your DID document, then publish your packages to it. The DWN is your registry.

```text
publisher:  didpkg publish --to dwn  ->  the DWN in the DID document
user:       npm install  ->  didpkg shim  ->  resolve the DID, read the DWN, verify
```

The publisher signs each release with a key from its DID document. Users install with plain npm, pnpm or bun, through a local shim on their computer. The shim verifies each package before npm gets it.

didpkg is experimental. Do not use it for production packages.

## Install

On Linux or macOS, the install script gets a standalone binary:

```sh
curl -fsSL https://didpkg.dev/install | sh
```

On each OS with Node 22 or later (also Windows), use npm:

```sh
npm install --global didpkg
```

[Install didpkg](docs/install.md) shows how to read the script before you run it, check a manual download, upgrade and uninstall. Note: `didpkg@0.1.0`, the release `v0.1.0` and `didpkg.dev` are not live yet. Until then, build the CLI from a clone ([quickstart, step 1](docs/quickstart.md#1-install-the-cli)).

To install a package by DID, start the shim. It runs until you push Ctrl+C.

```sh
didpkg shim start
```

In a second terminal, in your project folder, add 1 line to `.npmrc` and install:

```sh
echo '@didpkg:registry=http://127.0.0.1:2092/' >> .npmrc
npm install @didpkg/hello_did_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy
```

The install name holds the package name, the identifier kind (`did` or `xid`) and the identifier. A DID name also holds the DID method. The demo has the package `hello` from 8 publishers. The shim reads each `hello` package from the demo DWN `https://dwn.didpkg.dev`:

| Identifier | Install name |
|---|---|
| did:dht | `@didpkg/hello_did_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy` |
| did:web | `@didpkg/hello_did_web_nonni.org_pkgs_web` |
| did:webvh | `@didpkg/hello_did_webvh.v3jo2r5k_qmypg6w1wsqvexs8ej2z4nmaarfr4ekue3vykjmmdhxuij_nonni.org_pkgs` |
| did:plc | `@didpkg/hello_did_plc_cpvwafp2z4zqaidjkhyugj3p` |
| did:btcr2 | `@didpkg/hello_did_btcr2_x1qzpqymyzalnn0m4mg7llfwjewstugrdyznf8qdmde2png2tua07xvjlqu0l` |
| did:key | `@didpkg/hello_did_key.jipdria6_z6mkpxedd7bxksn37prfsajv7c6iu3kmg8geeovmjwp2ujry` |
| did:jwk | `@didpkg/hello_did_jwk.ek76dcyo6iflyzmfqpe_eyjjcnyioijfzdi1nte5iiwia3r5ijoit0tqiiwieci6iknkzgowvkwxanvtrnbpvg03mwpyduntbfdyx2cxbjy5dunzd1l5a2hruwmifq` |
| XID | `@didpkg/hello_xid_816d5e4543788d2ac68acef158545765a5da81caf6e68ad807e73c5b163a9967` |

6 publishers have the demo DWN in the DID document (or XID document). A did:key or did:jwk document has no services. Thus the shim needs the DWN as an option for these names. A XID name has no host. Thus the shim needs a XID resolver for it. For all 8 names, start the shim with the two options:

```sh
didpkg shim start --dwn https://dwn.didpkg.dev --xid-resolver https://nonni.org/pkgs/xid/
```

The [quickstart](docs/quickstart.md) gives each step and the HTTP errors. For one install with no shim, `didpkg drl` prints a verified tarball URL ([one-off install](docs/quickstart.md#one-off-install-with-no-shim)).

## Publish

Make a did:dht DID with a DWN service, register it on the DWN, then publish to the DWN:

```sh
didpkg id create main --dwn https://dwn.didpkg.dev
didpkg id register main
npm pack
didpkg publish main hello-1.0.0.tgz --to dwn
```

The output gives the install name. A static HTTPS mirror is an optional backup copy of the same signed bytes. [Publish a package](docs/publish.md) gives each step, the other DID methods, XIDs and the backup mirror.

## Documentation

The [docs index](docs/README.md) lists all documents. Start with these:

- [Quickstart](docs/quickstart.md): install the CLI, start the shim and install a package by DID.
- [Install didpkg](docs/install.md): npm, the install script, a manual download, upgrade and uninstall.
- [How didpkg works](docs/how-it-works.md): the checks at install, the trust model and the limits.
- [Publish a package](docs/publish.md): make a publisher DID and publish a package.
- [CLI reference](docs/cli.md): each command and its options.

## Layout

| Path | npm name | Role |
|---|---|---|
| `packages/core` | `@didpkg/core` | `name/`: the install-name grammar and the shim request router. `did/`: the DID resolver and the did:key, did:jwk, did:dht, did:web, did:webvh, did:plc and did:btcr2 drivers. `xid/`: the XID document reader and the XID resolver. `trust/`: the release proofs and the release verifier. `source/`: the storage contract and the npm packument. |
| `packages/adapter-https` | `@didpkg/adapter-https` | The static HTTPS mirror (`DIDPackageRepository`): the reader `httpsAdapter` and the `dir:` writer `DirWriter`, which also reads its folder back (ADR 0003 section 7). |
| `packages/adapter-dwn` | `@didpkg/adapter-dwn` | The publisher DWN (`DecentralizedWebNode`): the protocols v1 and v2, the reader `dwnAdapter` (with a rate limit per DWN origin) and the writer `DwnWriter` (ADR 0003 section 6). |
| `packages/cli` | `didpkg` | `didpkg name` and `didpkg parse` (from `didpkg@0.0.1`). `didpkg id create\|show`: a did:dht publisher DID, with the encrypted release key `#didpkg-1` and a separate update key file (`#0`). `didpkg id register`: accepts the terms of a DWN, then registers the DID there with a proof of work. `didpkg publish`: signs an `npm pack` tarball with `#didpkg-1` and writes the same bytes to the DWN and to `dir:` folders. `didpkg shim start`: the npm shim on 127.0.0.1, which verifies each packument and tarball before it serves them. `didpkg drl`: verifies one version as the shim does, then prints the tarball URL for a one-off install with no shim. |

## Develop

You must have Node 22 or later and npm. `npm install` also gets Bun 1.4.4 (the `bun` npm package, a development dependency). The tests, the build and the demo run on that Bun. You do not install Bun.

```sh
npm install
npm test
npm run typecheck
```

The test `packages/cli/test/interop-xid.test.ts` reads the XID documents, release records and SSKR shares of didpkg with `envelope`, the Rust reference tool of Gordian Envelope. The test needs Docker and a local image of the tool. If the image is absent, the test skips. Build the image before you run the test:

```sh
docker build -t didpkg-envelope-cli:0.35.0 packages/cli/test/interop
```

The `allowScripts` field in the root `package.json` lets the `bun` package run its install script, which gets the Bun binary. If you install with `--ignore-scripts`, run `npm rebuild bun` after the install.

The landing page for `didpkg.dev` is in `site/`: 1 HTML page, the CSS and the DWN protocol v1 definition. The build writes `site/dist`. The link check reads the site, the Markdown files and the GitHub URLs in the source. Each relative link and each anchor must have a target.

```sh
npm run site:build
npm run site:check
```

The standalone binaries for Linux and macOS (x64 and arm64) have the Bun runtime in them, thus a user needs no Bun and no Node. `packages/cli/compile.ts` builds all 4 on 1 machine. It writes `packages/cli/dist-bin`: 1 `.tar.gz` per target and `SHA256SUMS`. The workflow `release` tests each binary on a runner with its OS and CPU. A `v*` tag also makes the GitHub Release, with a build provenance attestation for each file.

```sh
npm run compile
```

The demo (`demo/e2e.ts`) starts a Pkarr relay, a `dwn-server` and a static mirror on 127.0.0.1. A did:dht publisher signs and publishes `demo/hello` to its DWN and to the mirror. A user with no keys then installs the package with npm, pnpm and bun through `didpkg shim start`. A did:web publisher (`did:web:web.didpkg.test`) hosts its `did.json` on a TLS site and publishes the same tarball to the same DWN and to that site, and npm installs it too. Then the DWN stops, and npm installs both packages from the mirrors. The demo makes a demo CA at run time, and a CONNECT proxy sends the did:web host to the TLS site (`demo/tls.ts`). The demo needs npm, Node, openssl and pnpm 11 or later.

```sh
npm run demo
```

The demo DWN (`dwn.didpkg.dev`) runs from the files in `deploy/`: the pinned `dwn-server` with a tenant allowlist, Traefik for TLS and the route allowlist, and a daily backup. The runbook is [docs/deploy.md](docs/deploy.md). The stack test starts the same files with a demo CA and a local relay. It needs Docker with Compose 2.24 or later, openssl and curl.

```sh
npm run stack
```

The live demo has 8 publishers. Each publisher publishes `hello@1.0.0` to the demo DWN `dwn.didpkg.dev`. 6 publishers also write a backup copy to a static mirror:

| Publisher | Backup mirror |
|---|---|
| `did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy` | The root of [bnonni/didpkg-demo](https://github.com/bnonni/didpkg-demo) on GitHub Pages |
| `did:web:nonni.org:pkgs:web` | `https://nonni.org/pkgs/web/`. The `did.json` file is in the same folder. |
| `did:webvh:QmYpG6W1WsQVeXs8eJ2z4NMAaRFr4EkUe3vyKJMMdHxUiJ:nonni.org:pkgs` | `https://nonni.org/pkgs/` |
| `did:plc:cpvwafp2z4zqaidjkhyugj3p` | `https://nonni.org/pkgs/plc/` |
| `did:btcr2:x1qzpqymyzalnn0m4mg7llfwjewstugrdyznf8qdmde2png2tua07xvjlqu0l` | `https://nonni.org/pkgs/btcr2/`. The genesis document is a raw block in IPFS. |
| The XID `816d5e4543788d2ac68acef158545765a5da81caf6e68ad807e73c5b163a9967` | `https://nonni.org/pkgs/xid/`. The mirror also holds the XID document, because the DWN does not hold it. |

The did:key and did:jwk publishers have no mirror, because their DID documents have no services.

This command starts a shim with the public Pkarr relays. Then it installs the 8 packages with npm, pnpm and bun:

```sh
npm run live -- --dwn https://dwn.didpkg.dev --xid-resolver https://nonni.org/pkgs/xid/ @didpkg/hello_did_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy @didpkg/hello_did_web_nonni.org_pkgs_web @didpkg/hello_did_webvh.v3jo2r5k_qmypg6w1wsqvexs8ej2z4nmaarfr4ekue3vykjmmdhxuij_nonni.org_pkgs @didpkg/hello_did_plc_cpvwafp2z4zqaidjkhyugj3p @didpkg/hello_did_btcr2_x1qzpqymyzalnn0m4mg7llfwjewstugrdyznf8qdmde2png2tua07xvjlqu0l @didpkg/hello_xid_816d5e4543788d2ac68acef158545765a5da81caf6e68ad807e73c5b163a9967 @didpkg/hello_did_key.jipdria6_z6mkpxedd7bxksn37prfsajv7c6iu3kmg8geeovmjwp2ujry @didpkg/hello_did_jwk.ek76dcyo6iflyzmfqpe_eyjjcnyioijfzdi1nte5iiwia3r5ijoit0tqiiwieci6iknkzgowvkwxanvtrnbpvg03mwpyduntbfdyx2cxbjy5dunzd1l5a2hruwmifq
```

## Old drpm code

The old drpm code is in the `legacy/*` tags, for example `legacy/v5.2.1`.

## Security

See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
