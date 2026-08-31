FROM node:22-alpine AS web
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN corepack enable && pnpm install --frozen-lockfile
COPY web/ ./web/
RUN pnpm --dir web run build

FROM golang:1.24-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN rm -rf internal/web/dist && mkdir -p internal/web/dist
COPY --from=web /src/web/dist/ ./internal/web/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/oh-my-cpa ./cmd/oh-my-cpa

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=server /out/oh-my-cpa /usr/local/bin/oh-my-cpa
RUN mkdir -p /data && chmod 700 /data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/oh-my-cpa"]
