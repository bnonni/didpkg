# The demo DWN image: @enbox/dwn-server 0.1.45 on Bun 1.4.4, the same versions as the didpkg tests.
# bun.lock pins every package. cborg is pinned to the version of the root lockfile.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
COPY package.json bun.lock ./
# The data folder belongs to the user bun, so a new named volume gets the same owner.
RUN bun install --frozen-lockfile --production --ignore-scripts && mkdir data && chown bun:bun data
USER bun
ENV DWN_SERVER_PACKAGE_JSON=/app/node_modules/@enbox/dwn-server/package.json
EXPOSE 3000
CMD ["bun", "node_modules/@enbox/dwn-server/dist/esm/src/main.js"]
