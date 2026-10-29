# Working on Oh My CPA

OMC adds user-owned identity, organization, management and usage observability to
CLIProxyAPI (CPA). CPA executes credentials and proxies model requests. OMC is a
single-replica Go application, embedded React SPA and SQLite WAL database.

## Load context progressively

Start with this file and the task's source files. Read only the relevant guide:

| Task | Read |
| --- | --- |
| Domain terminology | [CONTEXT.md](CONTEXT.md) |
| Architecture or a security boundary | [Architecture](docs/architecture.md) |
| Local setup and contribution | [Contributing](CONTRIBUTING.md) |
| Tests or CI | [Testing](docs/testing.md) |
| UI, layout or interactions | [Design](docs/design.md) |
| CPA integration or configuration writes | [CPA contract](docs/cpa-v8-compat.md) |
| Pricing or request cost | [Pricing](docs/pricing.md) |
| Agent tools or MCP | [Capabilities](docs/agent-capabilities.md) |
| Installation, updates or recovery | [Install](docs/install.md), [Operations](docs/operations.md) |
| Database or encryption keys | [SQLite runbook](docs/ops/sqlite-operations.md) |
| Publication | [Releasing](docs/releasing.md) |
| Public demo | [Demo operations](docs/ops/cloudflare-demo.md) |

Do not read every guide before editing. Follow a source symbol or a relevant link,
not the entire documentation tree. Code owns field lists, defaults, schemas and token
values; documentation explains boundaries, rationale and operator procedures.
`CLAUDE.md` points here; edit this file, not the symlink.

## Non-negotiable boundaries

- Keep keys, OAuth tokens and auth files out of ordinary responses, logs, preferences
  and browser storage. Fixtures, screenshots and Git contain no credentials or
  production data. Caller keys use masks and keyed-HMAC identities, never masks as IDs.
- Ordinary HTTP responses use handwritten DTO allowlists in `internal/api/`.
  Explicit credential editing/export requires its audited reveal path. The trusted
  Plugin Host is the bounded native-response exception described in Architecture;
  it does not authorize arbitrary target URLs or outbound `api-call` proxies.
- Sensitive operations fail closed when their required audit cannot be recorded.
  Preserve the distinction between refusing execution and reporting a write that
  has already succeeded; an audit failure cannot undo an upstream mutation.
- Ordinary CPA configuration writes serialize, check revisions, name changed paths and
  keep a restorable encrypted pre-write copy. Refuse if that copy cannot be saved.
  Adoption never overwrites or deletes configuration OMC does not own.
- CPA's usage queue has one consumer. Availability probes authenticate; they never
  pop a record. Preserve ingestion identity and historical cost/usage facts.
- One replica per data directory. Serialize SQLite access rather than adding lock
  retries. Migrations are forward-only; never edit applied migrations or migration
  bookkeeping. Price versions and audit events are append-only.
- Only the updater holds the Docker socket. The console remains socket-free,
  read-only and unprivileged. Updates name a product, not an image. OMC updates
  verify signed manifests with the compiled-in key and pull by digest; CPA updates
  pull its existing tag. Never upgrade a pinned image. Failed replacement health
  checks restore the previous container and image tag; never bypass verification.
- Ship assets in the Go binary, without CDN dependencies. Root and configured base
  paths must both work. A development-server pass does not prove the shipped build.

## Make the smallest coherent change

Protect the boundaries above and actual wire/storage/user contracts, not historical
implementations. Replace or delete redundant abstractions, tests and tooling. Do not
add compatibility paths, fallbacks or swallowed errors without a current contract.
Shared utilities belong in leaf modules, not in page-owned runtime state.

Before adding a test, name the failure and find the lowest existing layer that can
catch it. Prefer extending an owned case over adding another suite. A regression
must fail without the fix; prove that when practical. Do not test prose, CSS class
names, workflow shape or implementation details. Never fix a flake with retries,
fixed sleeps, skipped checks or longer waits. See Testing for commands and CI scope.

## Local workflow

- Use the pinned toolchains and scripts from `package.json` and `go.mod`.
- `pnpm dev` starts local development; `pnpm build` produces the embedded SPA.
- `pnpm test:fast` is the affected-check entry point; inspect `--plan` when selection
  unexpectedly widens. `pnpm test:frontend` runs frontend tests; `pnpm check:ui`
  exercises browser behavior. Choose further verification from Testing.
- Rerun a failing check first, not every previously passing check on unchanged code.
- Agents commit or push only when asked. Keep unrelated user changes out of the
  delivery. Use focused commits and report exactly what was and was not verified.
- Release and security checks are not optional; a release tag requires green main CI.

## Code and copy

Comments explain intent and trade-offs, in English. Keep external spellings intact:
JSON/SQL names, CPA fields and library props are contracts. Use idiomatic local code;
booleans describe state (`is`, `has`, `can`, `should`) and functions describe actions.
Use kebab-case CSS module classes through `styles['name']`.

User-visible copy belongs in `web/src/i18n/locales/`, in the owning file under `zh`,
`en`, `zh-Hant` and `ms`. Consult the i18n README, glossary and style guide only for
copy work. Use shared UI primitives and resolved theme tokens, not page-local clones.

## Documentation and delivery

Update the single guide a change makes inaccurate. Do not synchronize catalogs of
routes, defaults or tokens into prose; link to their source. Put a consequential
trade-off beside the subsystem it explains, not in a numbered decision ledger.
Git history carries past designs. Do not create an archive or mapping to preserve
superseded documentation. Technical documentation is English; the Chinese README
and localized UI copy are intentional exceptions.

Describe the adopted result, relevant risks and evidence. Do not turn discarded
options, session corrections or unrelated edits into titles, comments or PR content.
