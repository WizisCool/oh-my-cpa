# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22.23.2-alpine AS web
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN corepack enable && pnpm install --frozen-lockfile
COPY web/ ./web/
COPY scripts/ ./scripts/
RUN pnpm --dir web run build

FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN rm -rf internal/web/dist && mkdir -p internal/web/dist
COPY --from=web /src/web/dist/ ./internal/web/dist/
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=v0.1.0-dev
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
    -ldflags="-s -w -X github.com/oh-my-cpa/oh-my-cpa/internal/config.BuildVersion=${VERSION}" \
    -o /out/oh-my-cpa ./cmd/oh-my-cpa

# Certificates, timezone data and account files are architecture-independent. Preparing
# them natively keeps cross-platform builds from needing privileged QEMU registration.
FROM --platform=$BUILDPLATFORM alpine:3.21 AS runtime-data
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -g 10001 -S omc \
    && adduser -u 10001 -S omc -G omc \
    && mkdir -p /data && chown omc:omc /data && chmod 700 /data

FROM alpine:3.21
ARG VERSION=v0.1.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Oh My CPA" \
    org.opencontainers.image.description="Self-hosted management and usage observability for CLIProxyAPI" \
    org.opencontainers.image.source="https://github.com/WizisCool/oh-my-cpa" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$REVISION
COPY --from=runtime-data /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime-data /usr/share/zoneinfo/ /usr/share/zoneinfo/
COPY --from=runtime-data /etc/passwd /etc/group /etc/
COPY --from=runtime-data --chown=10001:10001 /data/ /data/
COPY --from=server /out/oh-my-cpa /usr/local/bin/oh-my-cpa
COPY deploy/base-path.sh /usr/local/bin/omc-base-path
COPY deploy/healthcheck.sh /usr/local/bin/omc-healthcheck
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD sh /usr/local/bin/omc-healthcheck
ENTRYPOINT ["/usr/local/bin/oh-my-cpa"]
