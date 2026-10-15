# AGENTS.md — Oh My CPA Agent Contract

> Coding agents load this file at the start of a session (a local `AGENTS.override.md` supersedes it). The root `CLAUDE.md` is a symlink to this file, so every agent reads one contract; edit `AGENTS.md`, never the link.
>
> **First principle: protect invariants, not implementations.** The rules below name what must stay true — security boundaries, data integrity, external contracts, user-visible behavior. How the code achieves that is yours to change. Act as a senior engineer with independent technical judgment, not as a caretaker of historical choices.

---

## 1. The project

CLIProxyAPI (CPA) handles protocol adaptation, credential execution, and proxying requests; Oh My CPA (OMC) provides **user-owned identity, naming, organization, a management facade, and usage observability** above it. Both are co-deployed in the same stack. OMC is a single-replica Go modular monolith + embedded React SPA + SQLite WAL, operating completely offline with zero CDN dependencies.

Read documentation when a task needs it, not up front. Useful starting points: `CONTEXT.md` (domain vocabulary and rules), `docs/architecture.md` (module map, data flows, invariants), `docs/design.md` (visual system), `docs/testing.md` (test placement and the verification detail). Read or grep the part you need instead of loading whole documents.

---

## 2. Rule tiers

Not every rule weighs the same. Know which tier you are working in.

### Tier 1 — invariants. Never violate; if a task appears to require it, stop and say so.

- **Secrets.** Never write the CPA management key, upstream API keys, OAuth tokens, or TLS private keys into ordinary responses, logs, preferences, frontend storage, or documentation. Caller keys appear only as display masks plus keyed-HMAC fingerprints. A sensitive operation whose audit record cannot be written must not proceed.
- **DTO allowlists.** Ordinary facade responses carry only handwritten allowlists from `internal/api/` — never raw CPA payloads, unlisted fields, arbitrary target URLs, or outbound `api-call` proxies. The authenticated trusted Plugin Host is the single bounded native-response exception (ADR 0067): fixed CPA v0/v8 management trees and the model directory only, with credential separation, audited reads and writes, and configuration backup gates.
- **Data integrity.** Migrations are forward-only: never edit an applied migration or `schema_migrations`; a fix is a new migration. Pricing versions and audit events are append-only. One replica per data directory — SQLite access is serialized, not retried.
- **Zero-destructive CPA adoption.** Never wipe, overwrite, or mutate pre-existing CPA configuration OMC does not own. Ordinary configuration writes are revision-guarded, name only the paths the operator changed, and keep a restorable backup; refuse the write when the backup cannot be made. Reading CPA's usage queue is destructive: availability is probed with AUTH, never by popping.
- **Update boundary.** Only the updater sidecar holds the Docker socket; the console stays read-only, unprivileged, and socket-free. An update names a product, never an image. Console releases are verified against the compiled-in public key and pulled by digest, with no unverified fallback; the gateway image, which this project cannot sign, pulls the tag its container already uses. A pinned image is never updated, and a replacement that fails its health check restores the previous container and its image tag.
- **Offline embedding.** No CDN or externally hosted asset; the SPA embeds in the single Go binary and keeps working under the `/omc` sub-path.
- **Repository hygiene.** No secret, key, token, or auth file in the diff, the history, the PR text, or screenshots.

### Tier 2 — contracts. Change deliberately, verify before and after, and say what changed.

- Wire formats and JSON field names; database schema and stored semantics; the CPA v0/v8 management contracts; the committed demonstration dataset's shape; environment variables and defaults; user-visible behavior and copy (`[zh, en]` pairs in `web/src/i18n/index.tsx` plus every catalog under `web/src/i18n/locales/`).
- Release and publication integrity: version identity, image tags and aliases, release gates, pinned workflow actions.

### Tier 3 — engineering preferences. Change freely.

- Module and package layout, internal abstractions and their names, naming and comment conventions (§6), test placement and organization, library choices, file and document structure.
- These conventions exist to keep the codebase coherent, not to freeze it. Deviate when you have a better reason, and prefer deleting an abstraction over preserving it. One design principle worth keeping: a shared component or module must not acquire a runtime dependency on a page's state just to obtain a general utility; put shared logic in a leaf module.

---

## 3. Your autonomy

You are authorized — and expected — to:

- refactor when it makes the code better; replace outdated abstractions; delete redundant implementations, dead code, and compatibility layers that serve no current contract;
- challenge historical decisions, including accepted ADRs (§4);
- move, rewrite, or delete tests that freeze implementation instead of protecting behavior;
- reorganize documentation.

Prefer making a bad state unrepresentable over a guard that silently absorbs it: do not add fallbacks, swallowed errors, or compatibility shims for a contract that does not exist.

Two conditions. Behavior in Tier 1 or Tier 2 is verified before and after the change. And coverage moves rather than disappears: if you delete a test, say where its claim now lives, or why the claim itself is obsolete.

---

## 4. ADRs

An ADR (`docs/adr/`) records a consequential decision and its context at a point in time. It is evidence, not a standing rule.

- Write a new ADR only when a decision is hard to reverse, involves real trade-offs, and affects architecture, an external contract, or a safety boundary. Routine refactors, UI polish, test strategy, dependency upgrades, and naming choices do not need one.
- You may amend, supersede, or deprecate any ADR, including accepted ones. Prefer editing an ADR whose facts or context are wrong over stacking a new one on top. When you reverse an accepted decision, note the reversal in the old ADR's status line and explain it in the new one.
- Read the corpus for context when working in an area it covers. If an ADR conflicts with current best judgment, propose the better design — it is a record of past reasoning, not a constraint list.

---

## 5. Verification

Match verification effort to the blast radius of the change:

| Moment | What to run |
| --- | --- |
| While editing | `pnpm test:fast` — only the checks the changed files need; add `pnpm check:ui` when the change touches UI interactions, layout, or browser lifecycle |
| Feature complete / before pushing | `pnpm verify`; add `pnpm check:ui` when the change touches the UI — the full static gates, the worktree secret scan, and the affected browser scenarios |
| Pull request | CI runs the full browser catalog, the whole probe catalog in three shards, and demo acceptance; branch protection requires its `static`, `browser`, and `probes` checks |
| Build, embedded distribution, browser harness, or workflow changes | `pnpm verify:full` (also for reproducing a CI failure) |

Do not run `verify` or `check:ui` after every file edit — a feature is complete when it is independently verifiable, not when a reply ends. Do not rerun a gate that already passed on unchanged code; when a check fails, rerun that check first. A documentation-only change is verified by `pnpm test:fast`, which selects the docs check; it needs no browser scenario. `pnpm test:fast --plan` shows the selection before you run it, and `pnpm check:ui` runs against the dev server with mocked endpoints, so it never replaces built-artifact acceptance for path resolution, minification, or chunk boundaries.

Rules that keep the gates honest:

- **Never add a skip switch, a retry, or a longer wait to make a run pass or go faster.** Fix the assertion, or add a planner rule with a self-test.
- **Write the check that catches the defect, not one that asserts the absence of trouble.** A test that cannot fail against a broken implementation, or that exists to cover the author rather than the code, is removed rather than kept.
- New tests go at the lowest layer that can fail for the right reason; no fixed waits; discovery is automatic, so do not add registration lists. `docs/testing.md` has the layer map and the current claim ownership.
- Release and security gates — secret scans, image smoke, publication checks — are never optional.

---

## 6. Conventions

**Comments explain why, not what.** The code already says what happens; a comment carries design intent, decision context, trade-offs, and non-obvious constraints. English only. Delete comments that restate the code, and update a comment when the logic under it changes.

```go
// Auto. Availability is probed with AUTH, never by popping: CPA's queue is
// destructive, so a probe that consumed a record would silently lose it.
```

| Style | Applies to |
| --- | --- |
| `lowerCamelCase` | Go/TS local variables, functions and methods, properties, parameters |
| `UpperCamelCase` | Classes, interfaces, structs, React components, exported types |
| `SCREAMING_SNAKE_CASE` | Module-level constants, global static read-only configuration |
| `snake_case` | Database tables and columns, SQL columns, JSON wire fields |
| `kebab-case` | URL paths, CSS class names, Git branches |

- Booleans carry a state prefix (`isActive`, `hasPermission`, `canEdit`, `shouldRetry`); functions are verb-noun phrases.
- External contract names keep their required spelling: `json:` tags, CPA native fields, DB columns, query parameters, and third-party component props. CSS-module classes are read as `styles['kebab-case']` (`pnpm check-css-modules` enforces that).
- User-visible copy is never hardcoded: add `[zh, en]` pairs to `web/src/i18n/index.tsx` and to every catalog under `web/src/i18n/locales/` (`pnpm check-i18n` finds gaps).

---

## 7. Documentation

Update the documents your change makes wrong, in the same change. That is the whole requirement — accuracy, not ceremony. `pnpm check-docs` catches the mechanical half: maintained documents must not cite unallowlisted missing paths or retired references, archival documents may retain explicitly listed historical paths, and non-archival documents carry no absolute line numbers (cite a file or symbol instead).

Where things live, when you need to check or update them:

| Document | Covers |
| --- | --- |
| `CONTEXT.md` | Domain vocabulary and rules: time windows, i18n, auth model, pricing semantics |
| `docs/architecture.md` | Module map, data flows, invariants, schema, background loops |
| `docs/design.md` | Visual system and design tokens (source of truth); `DESIGN.md` is its design-tooling summary and follows it |
| `PRODUCT.md` | Product positioning, capability matrix, constraints |
| `README.md` / `README.zh-CN.md` | Landing pages: capability or install changes a newcomer should see |
| `docs/install.md` / `docs/install-for-agents.md` | Installation for a person, and the same steps as an agent runbook |
| `docs/operations.md` | Settings reference, deployment constraints, operational notes |
| `docs/ops/sqlite-operations.md` | Backup, restore, master-key governance, migration gates |
| `docs/ops/cloudflare-demo.md` | Deployment runbook for the public demonstration |
| `docs/releasing.md` | Distribution, tag publishing, version identity |
| `docs/testing.md` | Test placement, the layer map, current claim ownership |
| `docs/agent-capabilities.md` | Agent capability contract and the MCP bridge |
| `docs/cpa-v8-compat.md` / `docs/cpamc-parity.md` | CPA v8 baseline and relocation; CPAMC parity matrix |
| `docs/plans/model-prices.md` | Pricing design, matching rules, known limitations |
| `docs/adr/` | Decision records (§4) |
| `docs/images/readme/` | README screenshots: regenerate with `pnpm build && pnpm readme:screenshots` when a pictured page changes how it looks |
| `deploy/cloudflare/data/` | The demo dataset: regenerate with `pnpm demo:generate` and commit the diff when a console read or response shape changes (`pnpm check:demo` fails otherwise) |

All context and technical documentation is written in English; `README.zh-CN.md` and localized UI copy are the intentional exceptions.

---

## 8. Common commands

The complete script list is in `package.json`; these are the ones agents use most.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Air + Vite dev entrypoint (`http://127.0.0.1:5173/omc/`) |
| `pnpm dev:api` / `pnpm dev:web` | Go/Air only, or Vite only |
| `pnpm cpa:start` | Start local CLIProxyAPI from `cpa/` |
| `pnpm build` | Build the frontend and sync it to `internal/web/dist` |
| `pnpm test:fast` | Affected checks for the worktree diff (`--base <ref>` includes committed changes, `--plan` prints the selection) |
| `pnpm test:logic` / `pnpm test:components` / `pnpm test:self` | Pure-logic suites / rendered React and typed API contracts / repository and Worker Node self-tests |
| `pnpm check:ui` | Affected browser scenarios on the dev server with mocked API (`--list` / `--plan` inspect without launching a browser) |
| `pnpm verify` | Toolchain check, full static gates, worktree secret scan |
| `pnpm verify:probes` | The whole dev-server probe catalog (`--shard i/n`, `--port PORT`, `--workers 1`) |
| `pnpm verify:browser` | Built-SPA browser acceptance against the fake CPA (also `:smoke`, `:p0`, `:harness`) |
| `pnpm verify:demo` | Browser acceptance for the public demonstration; `OMCPA_DEMO_URL` checks a deployment |
| `pnpm verify:full` | Everything CI runs, locally (`:serial` for resource-constrained hosts) |
| `pnpm verify:e2e` | Build and loading boundaries, then browser acceptance and probes |
| `pnpm verify:secrets` | Scan the worktree for secrets (`:history` scans history) |
| `pnpm check:bundle` | Production loading boundaries and anomaly ceilings, with size reports |
| `pnpm demo:generate` | Regenerate the demonstration dataset from the real handlers (`--check` fails when stale) |
| `pnpm check:demo` | The demonstration's coverage, freshness and privacy contract |
| `pnpm icons:generate` | Regenerate the Lucide icon data after the package changes |
| `pnpm check-docs` | Documentation path, retired-reference and line-number gate |
| `pnpm check-i18n` | Translation keys referenced in code but missing from the dictionary |
| `pnpm check-css-modules` | `styles[...]` references versus defined CSS-module classes |
| `pnpm check:motion` / `pnpm check:style-tokens` / `pnpm check:feedback` | Motion budget / type and radius scales / feedback-surface and shared-primitive gates |
| `pnpm lint:antd` | antd usage and accessibility rules |
| `pnpm readme:screenshots` | Regenerate README screenshots from demo mode (outside every gate) |
| `pnpm verify:race` / `pnpm verify:fuzz` / `pnpm verify:advisories` | Weekly maintenance lanes, separate from the PR gates |

---

## 9. Delivery surfaces: ship the result, not the conversation

Write for a reader who was not in the session. Rejected alternatives, intermediate attempts, and wording corrections are control information: they must not become the naming or narrative centre of a title, filename, comment, UI string, commit message, PR body, or handoff note.

- **Regenerate from the adopted state; do not patch rejected text.** If a title, label, or opening grew out of a discarded option, write it fresh from the positive goal. "Do not mention X" does not mean writing "no X" — drop the contrast instead of leaving a disclaimer.
- **Ask three questions per surface.** Does a reader without this session need it? Would omitting it cause inaccuracy, unsafety, misleading copy, or a compatibility gap? Is it a genuine change from the baseline that this surface must explain? If none apply, omit it — merely having appeared or been rejected is not a reason to keep something.
- **Keep what is real**: baseline changes, performed external actions, removed public APIs, migrations, security facts, and requested comparisons or decision records.
- **Do not fold unrelated changes into the commit, PR, or notes**, and do not claim pre-existing user edits as this task's output.
- Re-read the published surface — title, filename, metadata — after editing it, rather than asserting that it is clean.

---

## 10. Things not to do

- Do not fake feature completion because an endpoint can be probed; placeholder pages are marked as placeholders.
- Do not reference deleted files, retired pages, renamed identifiers, or deprecated external contracts in prose or comments.
- Do not introduce frontend resources requiring a CDN, and do not hardcode the root path.
- Do not treat a passing run as coverage: an assertion may move to a cheaper layer, but it must not disappear without a replacement that makes the same claim.
