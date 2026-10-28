# ADR 0002: Gate 2 (Phase 1 continue or stop)

- Status: PROPOSED. bnonni makes the decision. See [Decision](#decision).
- Date: 2026-10-28 (evidence), decision date: open
- Deciders: bnonni (continue or stop), agent (evidence)
- Evidence: this repository at `dbe072f` (C14a), the live DWN `https://dwn.didpkg.dev`, and the Pages site https://bnonni.github.io/didpkg-demo/.

## Context

PLAN.md Phase 1 builds the first end-to-end demo. Identity A signs a package and publishes it to its DWN and to a static mirror. User B has no keys and installs it by name with plain npm. A did:web publisher works the same way. Exit criterion 5 is this ADR: continue only if the demo passes and bnonni still wants a public beta.

## Versions

| Item | Version |
|---|---|
| Runtime | Bun 1.4.4 (`engines.bun >= 1.4.4`). Node v24.21.0 loads the installed package. |
| Installers | npm 11.19.0, pnpm 11.4.0, `bun add` (Bun 1.4.4) |
| Core pins | `@enbox/dids` 0.1.14, `@noble/curves` 2.4.0, `@noble/ed25519` 3.2.0, `@noble/hashes` 2.4.0, `@scure/base` 2.4.0, `canonicalize` 5.1.0, `web-did-resolver` 3.2.0 |
| DWN pins | `@enbox/dwn-sdk-js` 0.4.29, `@enbox/dwn-clients` 0.4.37, `dwn-server` 0.1.45 (image `didpkg-dwn:0.1.45`), Traefik v3.7.16 |
| did:dht publisher | `did:dht:eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy`, install name `@didpkg/hello_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy` |
| did:web publisher | `did:web:bnonni.github.io:didpkg-demo`, install name `@didpkg/hello_web_bnonni.github.io_didpkg-demo` |

## Exit criteria

1. `bun demo/e2e.ts` passes 3 times in a row from a clean clone, in less than 5 minutes: YES. C12a (`dd4d209`) and C12b (`d2038ad`) added the did:dht and did:web publishers. The CI job `demo` runs it 3 times on each push. Clean clone of `dbe072f` on 2026-10-28: 3 runs PASS in a row, 3.6 s, 3.7 s and 3.7 s.
2. Cold-cache installs from `dwn.didpkg.dev` with npm, pnpm and bun, Node loads the package, the did:web publisher installs, and the install passes from the mirror with the DWN stopped: YES (C14a, 2026-10-28). `bun demo/live.ts` passed with the DWN up (3.1 s) and with the `dwn` container stopped from 20:43:42 to 20:44:03 UTC (3.2 s). It passed again after the restart. A direct DWN read gave 1 copy of each release and tarball, with the same bytes as the mirror.
3. The publish, byte, vector, swap, revoke, yank and wrapper tests: YES (C11, `1cfb8c0`). Files: `packages/cli/test/publish.test.ts` (no `#0` key on disk, same DWN and mirror bytes), `packages/core/test/trust/vector.test.ts` (W3C `eddsa-jcs-2022`), `packages/cli/test/shim-npm.test.ts` (swapped tarball, `fake-registry.mjs`, revoked and yanked versions).
4. Driver conformance, W3C type URLs, `INVALID_DID_DOCUMENT` and the entry-point import test: YES. On `dbe072f`, `packages/core/test/did/` and `packages/core/test/imports.test.ts` give 64 pass, 0 fail:
   - `conformance.test.ts`: did:key, did:jwk, did:dht and did:web pass `runDriverConformance`.
   - `resolver.test.ts`: an invalid DID, an unsupported method and bad `versionId` and `versionTime` options give W3C type URLs. A driver that returns the document of another DID gives `INVALID_DID_DOCUMENT`.
   - `imports.test.ts`: each entry point imports with no `fetch`, no `WebSocket` and no process exit.
5. This ADR records the evidence and the decision: evidence YES, decision open.

Full suite on the clean clone of `dbe072f` (2026-10-28, 17:03 EDT): typecheck green, 333 pass, 0 fail, `deploy/test/stack.ts` PASS (8.7 s), gitleaks finds no leaks. After the runs, no Bun port is open and no test container is left.

## Hours

About 10 hours of session time (2026-10-27 17:00-22:03 EDT and 2026-10-28 11:25-16:50 EDT), against the 59-93 h estimate. Session time includes the waits for bnonni (signatures, pushes, the VPS and DNS). It is not a measured work time. The Phase 0 spikes and prototypes did a large part of the design work.

## Findings for Phase 2

These items do not block Gate 2. Each item is in the PLAN.md Change log of its chunk.

1. Trust: the rollback gap across keys (C3).
2. Sources: a stale mirror on first use and read-time equivocation (C4a).
3. Shim: a packument with more than about 110 versions on a cold DWN read, and no gzip bomb limit in `readTarball` (C10).
4. CLI: no command to yank, revoke or deprecate (C11). No `id update` command, so a did:dht service change needs a separate tool (C14a).
5. Mirror and deploy: the mirror path `<name>/<version>.json` has no DID, so 2 publishers cannot share 1 mirror URL (C14a). `tenant.sh` cannot remove a tenant (C13).

Open decisions: decision 7 (library names) before the first `@didpkg/core` publish. Decisions 6 (default method and did:dht retention) and 11 (DWN host for outside publishers) before Phase 2.

## Options

1. CONTINUE: make decision 7, publish `@didpkg/core@0.1.0`, then start Phase 2. Phase 2 starts with the findings above.
2. PAUSE: keep the demo DWN and the Pages site live, and make a demo video first. Decide after the outside response.
3. STOP: archive the repositories and stop the droplet. The npm names `didpkg` and `@didpkg` stay reserved.

Agent note: criteria 1-4 pass, so the technical evidence does not block CONTINUE. The public-beta question in criterion 5 is a product decision, thus bnonni makes it.

## Decision

Open. bnonni records the decision, the date and the reasons here.
