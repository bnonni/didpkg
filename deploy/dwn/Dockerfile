# The demo DWN image: @enbox/dwn-server 0.1.45 on Bun 1.4.4, the same versions as the didpkg tests.
# bun.lock pins every package. cborg is pinned to the version of the root lockfile.
# The image runs start.ts: dwn-server with the DID resolver of resolver.ts (did:dht, did:jwk, did:key, did:web, did:webvh, did:plc).
# resolver.ts imports the did:webvh and did:plc drivers from packages/core/src. The build context "core" gives that folder:
# deploy/compose.yaml sets it. Without Compose: docker build --build-context core=packages/core/src deploy/dwn
# The image has the same folder layout as the repo, so the relative imports of resolver.ts work. Bun runs the TypeScript.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
COPY package.json bun.lock ./
# The data folder belongs to the user bun, so a new named volume gets the same owner.
RUN bun install --frozen-lockfile --production --ignore-scripts && mkdir data && chown bun:bun data
COPY --from=core . packages/core/src/
COPY start.ts resolver.ts deploy/dwn/
USER bun
ENV DWN_SERVER_PACKAGE_JSON=/app/node_modules/@enbox/dwn-server/package.json
EXPOSE 3000
CMD ["bun", "deploy/dwn/start.ts"]
