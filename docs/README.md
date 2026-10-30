# didpkg documentation

| Document | Reader | Content |
|---|---|---|
| [Quickstart](quickstart.md) | User | Install the CLI, start the shim and install a package by DID. The HTTP errors of the shim. |
| [How didpkg works](how-it-works.md) | User, publisher | The parts, the checks at install, the trust model, the pins and the limits. |
| [Publish a package](publish.md) | Publisher | Make a did:dht or did:web identity, sign a package, write it to a DWN and a mirror. |
| [CLI reference](cli.md) | User, publisher | Each command, with its options, its output and its exit code. |
| [CLI package](../packages/cli/README.md) | User | The npm page of `didpkg`. |
| [Install names](spec/install-names.md) | Contributor, client author | The install-name grammar draft 1, the codec, the shim routes and the test vectors. |
| [Release records](spec/release-records.md) | Contributor, client author | The release record, the index, the digests, the proofs, the static layout v1 and the DWN paths. |
| [Deploy a DWN](deploy.md) | Operator | The runbook of the demo DWN `dwn.didpkg.dev`. |
| [ADR 0001](adr/0001-go-no-go.md) | Contributor | Gate 1: the Phase 0 go or no-go decision. |
| [ADR 0002](adr/0002-continue.md) | Contributor | Gate 2: the Phase 1 evidence, and the decision to continue, pause or stop. |
| [ADR 0003](adr/0003-storage-contract.md) | Contributor | The storage contract, the DWN protocol v1, the static layout v1 and the packument rules. |

All commands: [CLI reference](cli.md). Vulnerability reports and the denylist: [SECURITY.md](../SECURITY.md).
