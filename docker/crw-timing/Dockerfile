# Rebuild upstream CRW with only the verified opt-in estate timing patch.
FROM rust:1.96-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init && git remote add origin https://github.com/fastcrw/crw.git && git fetch --depth=1 origin 8978b36f7ae7f97e77a17ce3d03997b9722de382 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = 8978b36f7ae7f97e77a17ce3d03997b9722de382
COPY docker/crw-timing/timing.patch.gz /timing.patch.gz
RUN gzip -dc /timing.patch.gz > /timing.patch && git apply --check /timing.patch && git apply /timing.patch
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_DEBUG=0
RUN cargo build --locked --release -p crw-server --features cdp --bin crw-server
FROM ghcr.io/fastcrw/crw@sha256:80a18f51e41e7d4348aa43f2568e7603abe3b5b9b13adbae68a06b30a0582b46 AS upstream
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgcc-s1 && rm -rf /var/lib/apt/lists/*
COPY --from=upstream /app/ /app/
COPY --from=upstream /usr/local/bin/ /usr/local/bin/
COPY --from=builder /src/target/release/crw-server /usr/local/bin/crw-server
WORKDIR /app
LABEL org.opencontainers.image.version="0.38.0+estate-timing" org.opencontainers.image.revision="8978b36f7ae7f97e77a17ce3d03997b9722de382" estate.instrumentation="crawl.timing.v1"
EXPOSE 3000
CMD ["crw-server"]
