# AGENTS.md — Oh My CPA Project-Level Agent Contract

> This file is automatically loaded by coding agents (such as Pi, Claude Code, etc.) at the start of a session (a local `AGENTS.override.md` supersedes it).
>
> **First Principle: Keep context documentation synchronized with code.** Do not defer documentation updates to "the next cleanup task"—documentation drift is a defect in the current change and must be resolved within the same change.

---

## 1. One-Sentence Project Summary

CLIProxyAPI (CPA) handles protocol adaptation, credential execution, and proxying requests; Oh My CPA provides **user-owned identity, naming, organization, a management facade, and usage observability** above it. Both are co-deployed in the same stack. Oh My CPA is a single-replica Go modular monolith + embedded React SPA + SQLite WAL, operating completely offline with zero CDN dependencies.

Read these three documents before doing substantive work:

1. `CONTEXT.md` — Domain vocabulary and rules (time windows, i18n, authentication model, price semantics).
2. `docs/architecture.md` — Module map, data flows, and architectural invariants.
3. `docs/design.md` — Source of truth for the visual system and design tokens.

---

## 2. Context Documentation Map: What Changes, and Where to Update Synchronously

Treat the table below as a hard constraint. Whenever a change touches a "Trigger condition", you must update the corresponding document in the same change and state in your commit message or response which document was updated.

| Document | Purpose | Trigger Condition Requiring an Update |
| --- | --- | --- |
| `CONTEXT.md` | Domain terminology, domain rules | Adding, renaming, or deprecating domain concepts; changes to time windows, i18n, auth, pricing, provider disablement; discovering terminology discrepancies with the implementation |
| `docs/architecture.md` | Module map, data flows, invariants, schema, background loops | Adding or removing `internal/*` packages; router or middleware changes; data flow stage adjustments; new background loops; database schema or migration gate changes |
| `docs/design.md` | Source of truth for visual system and the derived palette; `DESIGN.md` is its design-tool summary | Changes to palettes or their derivation, typography, spacing, motion, or token mappings (must synchronously update `web/src/theme/palette.ts`, `web/src/theme/themeConfig.ts` and `web/src/index.css`) |
| `DESIGN.md` | Brand design system summary (for design tooling) | Same as `docs/design.md`; both must stay strictly synchronized |
| `PRODUCT.md` | Product positioning, capability matrix, constraints | Capability additions or removals, constraint shifts, target audience or positioning adjustments |
| `README.md` / `README.zh-CN.md` | User and operator landing page (English and Simplified Chinese) | Command, environment variable, default value, endpoint, deployment topology, or security boundary changes |
| `docs/adr/NNNN-*.md` | Important and irreversible architectural decisions | When a decision involves real trade-offs, **add a new** ADR; do not rewrite accepted ADRs (supersede them with a new ADR) |
| `docs/cpamc-parity.md` | Parity matrix against CPAMC | Changing an item from "planned/in-progress" to "covered"; interface capability or page wiring changes; newly identified gaps |
| `docs/ops/sqlite-operations.md` | Backup, restore, master key governance, migration gates | Migration or backup strategy, retention period, backup count, related environment variable default changes |
| `docs/plans/model-prices.md` | Pricing design, matching rules, known limitations | Pricing match chain, sync rules, pricing schema changes |

### Documentation Maintenance Checklist (Execute Before Declaring Complete)

1. **Run mechanical validation**: `pnpm check-docs` verifies that all backticked repository paths resolve, no retired artifacts are referenced, and non-archival documents contain no absolute line numbers.
2. **Search**: Grep all `*.md` files for identifiers, endpoints, environment variables, table names, and page names affected by the current change.
3. **Verify**: Cross-check statements line by line against the current code and runtime behavior; never rely on memory.
4. **Update**: Correct inaccuracies (divergence from implementation) → update deprecations (obsolete APIs/configs/dependencies) → supplement omissions (new modules, data flows, decisions).
5. **Check facts**: Ensure paths, endpoints, environment variables, default values, and table names mentioned in the documentation actually exist and match reality.
6. **Scan for residue**: Search for `prototype`, deleted files, removed pages/endpoints, and renamed identifiers—these references are historically the most frequent documentation defects in this repository.
7. **Language rule**: All context and technical documentation must be written in English (the user-facing `README.zh-CN.md` provides a localized Chinese entrypoint alongside `README.md`). Keep code comments strictly in English (see §4).

`pnpm check-docs` only proves that paths exist; it cannot verify whether the surrounding prose is factually accurate. Steps 2–5 still require careful human (or agent) review. When adding a retired artifact rule, add the entry and reason to `RETIRED_REFERENCES` in `scripts/check-docs.mjs`, and run `pnpm test:docs`.

**Do not write fragile absolute line numbers.** Reference `internal/api/handler.go` rather than `handler.go:53-128`; reference symbol names instead of line offsets. Line numbers are only permitted in frozen archival records (such as ADRs or historical audits) and must state their baseline commit.

---

## 3. Definition of Done (DoD)

Before declaring any change complete, all of the following requirements must be satisfied:

- The development loop prioritizes `pnpm test:fast`, which runs only the checks affected by the current worktree changes;
- When a logical feature is complete, run `pnpm verify` (toolchain check with version divergence warnings, full static gates, and worktree secret scan);
- Before declaring a task complete or pushing, run `pnpm verify:full` (adds git history secret scan, production build, bundle budget, and deterministic browser acceptance + probes);
- All context documents triggered by the change per §2 have been updated;
- No obsolete comments, dead references, or unlocalized user-visible strings remain.

### Three Verification Moments (Do Not Run the Full Suite Every Turn)

The real cost developers pay during development is **waiting**. Verification is structured across three distinct moments. Cramming the full test gate into every single iteration adds minutes to each turn—causing developers to bypass checks altogether, and a bypassed gate is no gate at all.

| Moment | What to Run | Approximate Cost |
| --- | --- | --- |
| **Development iteration** (after editing files to confirm nothing broke) | `pnpm test:fast`; add `pnpm check:ui` if the change touches UI interactions, layout, or browser lifecycle | 1–13s / 3–19s |
| **Logical feature complete** (end of an independently verifiable milestone) | `pnpm verify` | ~22s |
| **Before declaring done / pushing** | `pnpm verify:full` | ~95s |

Rules:

- **Do not run `verify` or `verify:full` after every individual response or single file edit.** "Logical feature complete" refers to an independently verifiable feature or fix, not a single reply or file edit.
- **Use `pnpm check:ui` for rapid UI feedback.** It requires no `pnpm build`, no Go binary, and no fake CPA (it runs against Vite dev server + mocked endpoints), running only scenarios affected by the changes; `--list` / `--plan` can inspect the scope and rationale without launching a browser. Because it runs on the **dev server**, it is the only place capable of catching issues exposed by `React.StrictMode` double-invocation.
- **`check:ui` does not replace built-artifact acceptance.** It tests against the dev server with mock endpoints, so it cannot observe path resolution, minification, or chunk boundary defects that only appear in production artifacts. Therefore, the end of a milestone and pre-push still require `verify:full`.
- **Do not rerun immediately if already run.** If `verify:full` at the end of a milestone already covered the identical, unchanged code and build artifacts, reuse that result rather than rerunning it immediately before pushing.
- **When a check fails, rerun only the failed check first**, rather than rerunning the entire suite after each fix.
- Selection logic resides in `scripts/affected-checks.mjs` (for checks) and `scripts/acceptance/check-ui-plan.mjs` (for UI scenarios); both are pinned by tests asserting they never silently select nothing.

CI (`.github/workflows/ci.yml`) runs static gates and browser gates in parallel: PRs use `verify:browser:smoke` for fast feedback, while `master` branch pushes use full `verify:browser` and `verify:probes` (executed concurrently, collecting exit codes independently). Both retain strict toolchain checks, secret scanning, and clean worktree assertions; a new run on the same ref cancels pending older runs. On browser test failures, screenshots, HTML snapshots, and application logs are uploaded as short-lived artifacts (`tmp/browser-acceptance-failure/`, `tmp/probe-failure/`).

---

## 4. Code Comments Convention

**Core principle: Explain Why, not What.** The code already states what is happening; comments explain why it was designed that way—design intent, decision context, trade-offs, boundary conditions, and non-obvious constraints.

- **Language**: Comments must be written in **English** only. Mixing languages is forbidden. When referencing UI concepts or states, use standard English terminology (such as "Live" or "open-ended").
- **Conciseness**: Annotate only core logic, potential edge cases, and complex algorithms. Do not restate function names or the obvious code flow (delete redundant comments like `// increment counter` or `// loop over items`).
- **Synchronization**: Logic changes must update corresponding comments. Outdated or misleading comments are treated as defects.
- **No historical residue**: Do not reference deleted files, retired pages, renamed identifiers, or deprecated external contracts.

Good example (from `internal/usage/ingest/runner.go`):

```go
// Auto. Availability is probed with AUTH, never by popping: CPA's queue is
// destructive, so a probe that consumed a record would silently lose it.
```

Counter-example:

```go
// Get the config.
func (s *Service) FetchConfig(ctx context.Context) (Config, error) {
```

---

## 5. Naming Conventions

| Style | Applies To |
| --- | --- |
| `lowerCamelCase` | Go/TS local variables, functions and methods, class/struct properties, parameters |
| `UpperCamelCase` | Classes, interfaces, structs, React components, exported types |
| `SCREAMING_SNAKE_CASE` | Module-level constants (`MAX_LOG_BUFFER_LINES`, `RENDER_CHUNK`), global static read-only configurations |
| `snake_case` | Database table and column names, SQL columns, JSON wire fields |
| `kebab-case` | URL paths, CSS class names (including `*.module.css`), Git branches |

Semantic requirements:

- Meaningless abbreviations are prohibited (`temp`, `tmp`, `a`, `b`, `obj`, `el`, `val`, `res`, `idx`); only pure loop counters may use `i`, `j`. Note that `idx` is particularly dangerous: in quota/credential loops it often represents a string Auth Index, not a numeric index.
- Booleans must carry a state prefix: `isActive`, `hasPermission`, `canEdit`, `shouldRetry`. React `useState` booleans follow the same rule (`isVisible`, `isSubmitting`).
- Functions/methods must use verb-noun phrases: `calculateTotal()`, `validateInput()`, `nextDelay()`, `formatRequestTick()`.
- User-visible copy must not be hardcoded in backend responses or frontend components; new copy must be added to `web/src/i18n/index.tsx` as `[zh, en]` pairs and to every complete catalog under `web/src/i18n/locales/`.

**Boundaries (Do not alter these purely for style)**:

- **Wire contract names preserve external casing**. `json:"disabled"` corresponding Go fields, CPA native fields, DB column names, and query parameters belong to external contracts; renaming Go/TS identifiers would widen diffs without improving readability. Naming conventions apply to our own identifiers.
- **Third-party component prop names follow the library API**. In `<Sider collapsed={isCollapsed}>` or `<Modal open={isOpen}>`, the left side is antd's interface and only the right side is our state variable. Similarly, `className="..."` strings are CSS classes (kebab-case) and must not be inadvertently mangled during identifier renames.
- Standard library structs in Go with exported boolean fields (such as `sql.NullString.Valid`) follow Go conventions and are not forced into `IsValid`. Exported Go identifiers use `UpperCamelCase`, while package-internal variables and unexported fields use `lowerCamelCase`.
- **CSS Modules class names are kebab-case and accessed via `styles['kebab-case']`**. Never use `styles.camelCase`. Because `tsc` cannot catch this (`vite/client` types `*.module.css` as `Record<string, string>`), `pnpm check-css-modules` enforces this check; run it after adding or renaming classes.

---

## 6. Common Commands

Test layering criteria and "what belongs in the browser" are detailed in [`docs/architecture.md`](docs/architecture.md) §11:
**Pay the browser testing cost only when Chromium is genuinely needed.** `pnpm test:fast` never builds, never launches Vite / Chromium / fake CPA; selection logic lives in `scripts/affected-checks.mjs` and its tests assert this property.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Air + Vite dev entrypoint (`http://127.0.0.1:5173/omc/`) |
| `pnpm dev:api` / `pnpm dev:web` | Run Go/Air only, or Vite only |
| `pnpm cpa:start` | Start local CLIProxyAPI from `cpa/` |
| `pnpm build` | Build frontend and sync to `internal/web/dist`; type checking is handled by independent gates |
| `pnpm test:fast` | Concurrently run minimum affected checks based on worktree changes (default for development iterations) |
| `pnpm check:ui` | UI fast lane: dev server + mock API, running only affected scenarios; `--list` / `--plan` inspects without launching a browser |
| `pnpm verify` | Toolchain check (warns on version divergence) + full static gates + worktree secret scan |
| `pnpm verify:full` | Parallel orchestrated full final gate |
| `pnpm verify:full:serial` | Serial final gate, used only for diagnosing parallel orchestration discrepancies |
| `pnpm verify:browser` | Run deterministic browser acceptance against built SPA (with fake CPA fixture) |
| `pnpm verify:browser:smoke` | Run browser smoke tests covering core auth, dashboard, and request list paths |
| `pnpm verify:probes` | Run browser probes requiring real Chromium for geometry, stacking, pixels, and refresh sequencing |
| `pnpm verify:e2e` | Build first, then run browser acceptance and browser probes |
| `pnpm verify:secrets` | Scan worktree for secrets |
| `pnpm check-i18n` | Find translation keys referenced in code but missing from the dictionary |
| `pnpm check-docs` | Validate context document path references, retired references, and absolute line numbers (`pnpm test:docs` self-test) |
| `pnpm check-css-modules` | Validate every `styles[...]` reference matches a defined class in `*.module.css` (`pnpm test:css-modules` self-test) |
| `pnpm check:motion` | Enforce §7's motion budget: every duration is a `--motion-*` token, no transition animates a layout property, every keyframe honours `prefers-reduced-motion`, and hovers stay within `fast` (`pnpm test:motion` self-test) |
| `pnpm lint:antd` | Check antd usage and accessibility rules |

---

## 7. Delivery Surface Cleanup: Describe Only Adopted State

Rejected options, intermediate attempts, and phrasing corrections in a session are **control information**, not the identity of the final artifact. When writing delivery materials, assume the reader has not seen the session.

Evaluate every delivery surface independently: titles, filenames, body prose, comments, labels, commit messages, PR descriptions, and handoff notes.

- **Generate from the positive goal, do not edit rejected text word by word.** If prominent titles, openings, tags, or filenames came from discarded alternatives, rewrite them rather than substituting synonyms or adding explanatory parentheticals.
- **Criteria for omission**: Does a reader who was not in this session need this information? Would omitting it make the product unsafe, inaccurate, misleading, incompatible, or non-compliant? Is it a genuine change from the baseline state that the current delivery surface must explain? If none of these apply, omit it completely.
- **"Do not mention X" does not mean writing "No X".** Remove unnecessary contrasts entirely instead of leaving a compliance disclaimer.
- **Must retain**: Genuine baseline changes, executed external actions, and necessary technical names, diagnostics, tests, snapshots, and audit facts. Do not erase real deletions, API names, or security facts just to avoid a particular word. Pre-existing user modifications from before the task started do not count as rejected content; do not absorb them into the current commit or PR narrative.
- **Write against diffs and re-read state**, avoiding absorbing unrelated changes into the narrative. After modifying artifacts, read through all user-visible content and packaging (including filenames and metadata); do not add disclaimers such as "cleaned up" or "no residue".

---

## 8. Things NOT to Do

- Do not bypass `internal/api` DTO allowlists to proxy raw CPA responses; do not introduce "arbitrary URL / arbitrary CPA endpoint" proxies.
- Do not write CPA management keys or any upstream secrets into ordinary responses, logs, preferences, frontend storage, or documentation.
- Do not modify historical database schema without a new migration; rollbacks must be forward-only (new migration fixes), never manually edit `schema_migrations`.
- Do not introduce frontend resources requiring a CDN; the frontend must be embeddable into a single Go binary for offline operation.
- Do not hardcode the root path; the `/omc` sub-path must continue to work natively.
- Do not write fragile absolute line references such as `path.go:123-456` (`pnpm check-docs` fails immediately on non-archival documents); reference filenames or symbol names.
- Do not fake feature completion simply because an endpoint can be probed; placeholder pages must be explicitly marked as placeholders.
- Do not rewrite accepted ADRs; when new trade-offs emerge, author a new ADR to supersede the previous one.
