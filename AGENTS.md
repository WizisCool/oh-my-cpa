# Working on Oh My CPA

OMC adds user-owned identity, organization, management and usage observability to
CLIProxyAPI (CPA). CPA executes credentials and proxies model requests. OMC is a
single-replica Go application, embedded React SPA and SQLite WAL database.

`CLAUDE.md` is a symlink to this file; always edit `AGENTS.md`.

## Progressive context loading

Start with this file and the task's source files. Read only the guide relevant to your task:

| Task | Read |
| --- | --- |
| Domain terminology | [CONTEXT.md](CONTEXT.md) |
| Architecture or security boundaries | [Architecture](docs/architecture.md) |
| Local setup and contribution | [Contributing](CONTRIBUTING.md) |
| Testing pyramid, commands or CI | [Testing](docs/testing.md) |
| UI, layout or interaction primitives | [Design](docs/design.md) |
| CPA integration or configuration writes | [CPA contract](docs/cpa-v8-compat.md) |
| Pricing or request cost | [Pricing](docs/pricing.md) |
| Agent tools or MCP | [Capabilities](docs/agent-capabilities.md) |
| Installation, updates or operations | [Install](docs/install.md), [Operations](docs/operations.md) |
| Database backup, recovery or encryption keys | [SQLite runbook](docs/ops/sqlite-operations.md) |
| Release packaging and signing | [Releasing](docs/releasing.md) |
| Public Cloudflare demo | [Demo operations](docs/ops/cloudflare-demo.md) |

Do not read every guide before editing. Executable code owns field lists, defaults,
schemas and design-token values; documentation explains system boundaries, rationale
and operator procedures.

---

## Judgment and autonomy

- Before adding complexity for a speculative or highly improbable race condition or security edge case, explain the specific failure mode, its likelihood, and the complexity cost to the user and obtain their approval. Never silently expand scope for theoretical robustness.
- Act immediately when you have sufficient information. Ask questions only when the answer would change your actions and cannot be resolved from the request, the codebase, or a reasonable reversible default. When making an assumption, state it explicitly.
- When facing distinct approaches with a significant trade-off, recommend one with a brief rationale. Mention alternatives only when the trade-offs are genuinely close.
- Drive work through to a verified final result. Do not stop at a plan, and do not hand back steps you can complete yourself.
- When a step does not require user input, keep going. Combine progress updates with your next action in the same message; never end a turn with a status-only update.
- Watch for XY problems: when a request specifies a particular solution, check whether it truly serves the underlying goal. If it looks like a workaround for a different issue, point out the likely root goal and a more direct path before building the requested workaround. When the specified solution is sound, build it directly.
- For complex plans, mentally trace the entire plan to its final state before executing, then re-examine the initial premises with that hindsight (Pólya's "looking back"). Viewing the whole trajectory often reveals a much simpler or better path that was not obvious at the start — such as a refactoring that makes most of the plan unnecessary, or a problem that does not need to exist at all. Surface such findings before executing the original plan.
- Solve the requested problem completely. Mention related edge issues, but do not fix them unprompted. If a proper fix goes substantially beyond the expected scope of the request or requires hard-to-reverse changes (such as data migrations or breaking API changes), explain before implementing.
- When an approach fails to converge (makes no progress), change how you gather evidence (narrow to a minimal reproduction, add instrumentation, verify untested assumptions) instead of blindly trying variations. If blocked on something only the user can resolve, state what you tried and what you need.

## Engineering standards

- Treat the project's existing architecture, conventions, and toolchain as the default baseline, not an absolute constraint. Match local naming and idioms in modified code. When project documentation (`AGENTS.md`, architecture guides) disagrees with legacy implementation details, follow the direction in the documentation.
- Do not extend patterns you recommend deprecating. When an existing design becomes an obstacle (redundant layers, useless abstractions, duplicated mechanisms), point it out and propose a simpler model — after first understanding why it existed.
- Simplification within the scope of your change is part of the job: prefer deletion over addition. Broader structural refactorings follow the scope rules above.
- Change conventions thoroughly as a single deliberate migration; never quietly introduce a second way of doing things beside the existing one. A half-finished migration is worse than either convention alone.
- Build only for clear, immediate needs (YAGNI). Do not introduce abstraction layers, configuration knobs, extension points, or premature generality without a current requirement.
- Duplication is cheaper than the wrong abstraction: extract an abstraction on the third occurrence, not the first (Rule of Three). When in doubt, choose the simplest design that passes the tests and expresses intent (Beck's rules of simple design).
- Prefer readable, explicit code over clever abstractions. Comments explain non-obvious intent, constraints, or trade-offs — never restate what the code does.
- When fixing a bug, add a regression test when the cost is low and confirm that the test fails without the fix. For new features, write targeted tests for the change; use test-first when it helps clarify the design.
- Before declaring coding work complete, run relevant tests as well as all available builds, linters, and type checks. If any check could not be run, explicitly state which one and why.
- Prefer code, type definitions, test cases, and adjacent comments over standalone documentation. Add or expand documentation files only when information cannot live next to the code or when explicitly requested.

---

## Architecture & non-negotiable boundaries

- **Backend layered structure**:
  - `cmd/oh-my-cpa/`: CLI entrypoints (`serve`, `updater`, `mcp`, `database`).
  - `internal/api/`: HTTP transport, auth/CSRF middleware, handwritten DTO projections, SSE streaming.
  - `internal/operations/`: Shared business mutations (validation, revision checks, write gates, backups, readback) consumed by both HTTP handlers and Agent/MCP capabilities.
  - `internal/capability/`, `internal/agent/`, `internal/mcpbridge/`: Capability registry, Agent loop/persistence, and MCP transport adapters.
  - `internal/cpa/`: Gateway v8 management client, lossless YAML patching (`configyaml`), credential discovery.
  - `internal/repository/`: Single-writer SQLite WAL persistence, forward-only migrations (`internal/repository/migrations/`), encrypted fields and backups.
  - `internal/ingest/`, `internal/usage/`, `internal/pricing/`, `internal/quota/`: Usage ingestion, token accounting, versioned price book, and quota observation/warmup.
- **Frontend structure (`web/src/`)**:
  - `pages/`: Route-level views loaded through `App.tsx` and `PageLoading.tsx`.
  - `components/common/` & `components/feedback/`: Shared interaction primitives (`AppModal`, `ConfirmAction`, `NumberInput`, `SearchSelect`, `RowReorder`, `RefreshButton`, etc.). Always reuse shared primitives before building page-local controls.
  - `api/` & `hooks/`: Typed HTTP client and React Query hooks.
  - `types/`: Domain models and pure state/derivation helpers.
  - `theme/` & `i18n/`: Tokenized palette/theme projection and 4-locale catalogs (`zh`, `en`, `zh-Hant`, `ms`).
- **Security & data invariants**:
  - Never expose raw keys, OAuth tokens or auth files in ordinary DTOs, logs, preferences or browser storage. Caller keys use masks and keyed-HMAC identities, never masks as join keys. CPA's management key is the one deliberate exception: the console mirrors it into the CPAMC-compatible browser storage that plugin pages written for CPAMC read, and puts it nowhere else.
  - Sensitive operations fail closed when their required audit record cannot be written.
  - CPA configuration writes serialize, check revisions, name changed paths, and save a restorable encrypted pre-write backup before mutating upstream state.
  - Availability probes authenticate without popping usage records.
  - One replica per SQLite data directory. Migrations are strictly forward-only; never edit applied migration files. Price versions and audit logs are append-only.
  - Only the updater container holds the Docker socket; the console stays socket-free, read-only and unprivileged. OMC updates verify Ed25519-signed manifests and pull by digest.
  - The production SPA is embedded into the Go binary (`internal/web`). Both root (`/`) and configured `OMCPA_BASE_PATH` must work.

## Testing governance & anti-bloat rules

To keep local feedback and CI fast, follow the 3-tier testing pyramid in [Testing](docs/testing.md):

1. **Tier 1 — Pure Logic & Go Unit Tests (default layer)**:
   - Backend logic, SQLite persistence, and API handlers live in `*_test.go` beside the package. Fresh SQLite test databases automatically use the cached post-migration bootstrap snapshot; avoid re-seeding multi-thousand-row demo fixtures outside `internal/demo` and `demo_export_test.go`.
   - Frontend pure derivations, reducers, and HTTP contract fixtures live in `web/tests/logic/*.test.ts` and `web/tests/*.contract.test.ts` (Vitest `logic` project, Node environment, `isolate: false`).
   - **Rule**: Extend existing domain test files instead of creating a new micro-test file for a single helper function. Do not write tests for speculative edge cases or trivial getters/formatters.
2. **Tier 2 — Component Wiring Tests (`web/tests/*.component.test.tsx`)**:
   - Exercised in Vitest `components` (jsdom, `isolate: false`, `motion: false` via `renderWithOmc`).
   - Use only for non-trivial stateful React/Ant Design workflows (form drafts, optimistic rollback, multi-step dialogs).
   - **Rule**: Never mount full pages or Ant Design trees in jsdom to test static rendering, copy strings, CSS class names, or pure view-model derivations that belong in Tier 1.
3. **Tier 3 — Built-Artifact Browser Acceptance (`scripts/browser-acceptance.mjs`)**:
   - Runs Playwright Chromium against the real compiled Go binary, embedded SPA, SQLite, and fake CPA (`pnpm verify:browser:smoke` for PRs, `pnpm verify:browser` for full acceptance).
   - **Rule**: Do not maintain a mocked dev-server Playwright probe suite. Do not reintroduce per-feature browser probe scripts or use Playwright to test CSS geometry, static copy, or isolated component states already covered by Tier 1/2.

## Verification workflow

- `pnpm test:fast`: Fast local verification (`pnpm type-check && pnpm test:logic && go test -short ./...`). Runs in seconds without building the binary or launching a browser.
- `pnpm test:frontend`: Runs all Vitest `logic` and `components` suites (`~20s`). For targeted iteration, run `pnpm exec vitest run --config web/vitest.config.ts <file>`.
- `pnpm verify:browser:smoke`: Builds the embedded SPA + Go binary and runs the fast end-to-end Chromium smoke check.
- `pnpm verify`: Runs `test:fast`, `test:components`, and `verify:build` (`type-check`, `build`, `check:bundle`).
- Agents commit or push only when explicitly asked by the user.

## Code style & documentation hygiene

- Write all technical documentation (`AGENTS.md`, `CONTEXT.md`, `CONTRIBUTING.md`, `docs/**/*.md`) and code comments in English. Only `README.zh-CN.md` and `web/src/i18n/locales/zh*` use Chinese.
- Corners use the five-step scale (`--radius-xs|sm|md|lg|xl`, `RADIUS` in TypeScript) by role, never a literal length, and nested shapes stay concentric (inner = outer − gap); see [Design](docs/design.md#corners).
- Edges are shadows, not borders: a surface takes `--shadow-edge|raised|float|overlay`, a control `--shadow-control`, a field or track `--shadow-well`, and a state recolours the ring. Ring strength is solved per palette (`EDGE_STEPS`), so never hand-tune one surface's shadow; see [Design](docs/design.md#edges-and-elevation).
- Keep external contract spellings (`JSON`, `SQL`, CPA YAML fields) exact. Use `is`/`has`/`can`/`should` prefixes for booleans and kebab-case CSS module classes via `styles['class-name']`.
- User-visible copy belongs in all four locale catalogs (`web/src/i18n/locales/{zh,en,zh-Hant,ms}/`).
- **No defensive copy or condition enumeration**: When authoring UI subtitles, descriptions, and hints, never write defensive disclaimers (e.g. "不是xxx", "并非xxx"), fallback/empty-state condition enumeration (e.g. "为空时xxx，为xx时xxx", "0 表示xxx", "留空则xxx"), or operational commands (e.g. "修改后需重启"). State capabilities directly in a single calm sentence; let placeholders, units, and control defaults communicate fallback behavior. If a control is self-explanatory (ports, paths, URLs with placeholders, standard switches), omit the subtitle entirely.
- Prefer self-documenting code, types, tests, and adjacent comments over standalone prose. Update `docs/` only when an architectural boundary, operator procedure, or public contract actually changes. Never append migration numbers, internal function names, or historical change logs to operational docs.
