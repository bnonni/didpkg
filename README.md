# didpkg

didpkg is a package manager with the DID (Decentralized Identifier) of the publisher as the root of trust. The publisher signs each release with a key from its DID document. The DWN (Decentralized Web Node) of the publisher is the registry. Static HTTPS mirrors hold the same signed bytes. Users install with plain npm, pnpm or bun, through a local shim that verifies each package before npm gets it.

## Status

Phase 1 (the first end-to-end demo) started on 2026-10-27, after the Gate 1 GO ([ADR 0001](docs/adr/0001-go-no-go.md)). The code is not usable yet. The npm package `didpkg@0.0.1` holds only the install-name codec.

The old drpm code is in the `legacy/*` tags, for example `legacy/v5.2.1`.

## Layout

| Path | npm name | Role |
|---|---|---|
| `packages/core` | `@didpkg/core` | `name/`: the install-name grammar (G1) and the shim request router. Phase 1 adds `did/`, `trust/` and `source/`. |
| `packages/adapter-https` | `@didpkg/adapter-https` | The static HTTPS mirror (`DIDPackageRepository`): the reader `httpsAdapter` and the `dir:` writer `DirWriter`, which also reads its folder back (ADR 0003 section 7). |
| `packages/adapter-dwn` | `@didpkg/adapter-dwn` | The publisher DWN (`DecentralizedWebNode`): the protocol v1, the reader `dwnAdapter` and the writer `DwnWriter` (ADR 0003 section 6). |
| `packages/cli` | `didpkg` | `didpkg name` and `didpkg parse` (from `didpkg@0.0.1`). `didpkg id create\|show`: a did:dht publisher DID, with the encrypted release key `#didpkg-1` and a separate update key file (`#0`). `didpkg publish`: signs an `npm pack` tarball with `#didpkg-1` and writes the same bytes to the DWN and to `dir:` folders. Phase 1 adds `shim`. |

## Develop

You must have Bun 1.4.4 or later.

```sh
bun install --ignore-scripts
bun test
bun run typecheck
```

## Security

See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
