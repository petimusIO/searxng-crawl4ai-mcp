# Rebuild upstream CRW with only the verified opt-in estate timing patch.
FROM rust:1.96-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init && git remote add origin https://github.com/fastcrw/crw.git && git fetch --depth=1 origin a0e4cbcdf03a89e60fcc9f6c3ec45e6d23a8d755 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = a0e4cbcdf03a89e60fcc9f6c3ec45e6d23a8d755
COPY docker/crw-timing/timing.patch.gz /timing.patch.gz
RUN gzip -dc /timing.patch.gz > /timing.patch && git apply --check /timing.patch && git apply /timing.patch
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_DEBUG=0
RUN cargo build --locked --release -p crw-server --features cdp --bin crw-server
FROM ghcr.io/fastcrw/crw@sha256:a063ca83e7362c587435df8f91adeee72f3189a3d36d97506400350be2b08dca AS upstream
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgcc-s1 && rm -rf /var/lib/apt/lists/*
COPY --from=upstream /app/ /app/
COPY --from=upstream /usr/local/bin/ /usr/local/bin/
COPY --from=builder /src/target/release/crw-server /usr/local/bin/crw-server
WORKDIR /app
LABEL org.opencontainers.image.version="0.37.2+estate-timing" org.opencontainers.image.revision="a0e4cbcdf03a89e60fcc9f6c3ec45e6d23a8d755" estate.instrumentation="crawl.timing.v1"
EXPOSE 3000
CMD ["crw-server"]
