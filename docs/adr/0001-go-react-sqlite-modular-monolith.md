# ADR 0001: Go backend with embedded React and SQLite

- Status: Accepted
- Date: 2026-02-20

## Context

Oh My CPA is a self-hosted management and identity layer for CLIProxyAPI. It needs a long-running HTTP API, CPA Management API integration, a RESP usage collector, metadata synchronization, and a browser UI that works at a configurable sub-path such as `/omc`. The intended deployment is a single Docker Compose stack alongside CPA, with a small operational footprint and a simple persistent data directory.

## Decision

Use a modular monolith with:

- Go for the backend and background workers.
- React with TypeScript, Vite, and Ant Design for the frontend.
- React build output embedded into the Go binary with `go:embed`.
- SQLite in WAL mode for the first deployment model, with one Oh My CPA replica.
- The CPA Management API over HTTP and a small custom RESP client for usage collection.
- Direct service-to-service CPA connections inside the Compose network; the public reverse proxy handles browser traffic only.

The backend owns the runtime Base Path contract. The default UI path is `/omc`, the API is `/omc/api/v1`, and media is `/omc/media`. The proxy preserves the prefix.

## Consequences

### Positive

- One binary and one container are straightforward to distribute.
- CGO-free builds can target common architectures when using `modernc.org/sqlite`.
- Go's concurrency model fits long-lived collectors and graceful shutdown.
- SQLite keeps the self-hosted installation simple and backup-friendly.
- TypeScript retains safe modeling for the resource identity layer and Ant Design forms.

### Trade-offs

- SQLite is a single-writer, single-replica starting point; horizontal scaling needs a future PostgreSQL/lease design.
- Usage ingestion must use durable inboxes, idempotency, and completeness indicators because CPA's queue/PubSub semantics are not an exactly-once log.
- Frontend assets must be built before the Go binary and copied into the embed directory.
- The public reverse proxy and application must agree on prefix preservation; stripping `/omc` breaks routing and callbacks.

## Alternatives considered

- **Node.js backend**: viable, but less aligned with CPA/Usage Keeper and less convenient for a compact single binary.
- **Full Ant Design Pro scaffold**: rejected for the initial product shell; use Ant Design and selected ProComponents without allowing a generic admin layout to define the resource-first experience.
- **PostgreSQL from day one**: deferred because the first target is a self-hosted personal/small-team deployment where a durable SQLite file is a materially simpler installation.
- **A generic Redis client for CPA RESP**: rejected because CPA exposes only a minimal RESP subset and generic clients may send unsupported negotiation commands.
