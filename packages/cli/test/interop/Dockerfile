# The Rust reference tool of Gordian Envelope (`envelope`), for the test `interop-xid.test.ts`.
# bc-envelope-cli 0.35.0 uses bc-envelope 0.43.0: the TypeScript libraries are checked against that version.
# Build: docker build -t didpkg-envelope-cli:0.35.0 packages/cli/test/interop
FROM rust:1-slim-trixie AS build
RUN cargo install bc-envelope-cli --version 0.35.0 --locked

FROM debian:trixie-slim
COPY --from=build /usr/local/cargo/bin/envelope /usr/local/bin/envelope
ENTRYPOINT ["envelope"]
