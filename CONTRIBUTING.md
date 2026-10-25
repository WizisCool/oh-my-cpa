# Contributing to Oh My CPA

Thank you for your interest in contributing to Oh My CPA! We welcome bug reports, feature suggestions, documentation improvements, and code contributions.

Bug reports and feature requests go through the issue forms under [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/); security vulnerabilities are reported privately as described in [`SECURITY.md`](SECURITY.md).

---

## Code of Conduct & Ground Rules

- **Zero Secret Exposure**: Never submit real API keys, tokens, auth files, or sensitive production data in pull requests, issues, or commit history.
- **Explain Why, Not What**: Code comments must be written in **English** and focus on design rationale, non-obvious constraints, and edge cases.
- **Keep Docs Accurate**: If your change alters an endpoint, configuration, UI token, or architectural boundary, update the documents it makes wrong in the same pull request (see [`AGENTS.md`](AGENTS.md) §7).

---

## Getting Started

### Prerequisites

- **Go**: 1.26+ (pinned to `1.27.3` in CI)
- **Node.js**: 22+ (pinned to `22.23.4`)
- **pnpm**: 11+ (pinned to `11.19.0`)
- **Air**: (optional, for Go hot reloading): `go install github.com/air-verse/air@latest`

### Local Development Setup

1. **Fork and clone the repository**:
   ```bash
   git clone https://github.com/<your-username>/oh-my-cpa.git
   cd oh-my-cpa
   pnpm install --frozen-lockfile
   ```

2. **Set up local environment**:
   ```bash
   cp .env.example .env
   ```
   Provide a 32-byte hex string for `OMCPA_MASTER_KEY` (`openssl rand -hex 32`) and your local CLIProxyAPI management key for `OMCPA_CPA_MANAGEMENT_KEY`.

3. **Start the development servers**:
   ```bash
   pnpm dev
   ```
   This launches Air (watching Go backend on `:8080`) and Vite (frontend dev server on `:5173`) concurrently. Access the console at **`http://127.0.0.1:5173/omc/`** (`/omc` redirects there).

---

## Verification Gates

Run `pnpm test:fast` while editing and before pushing: it selects only the checks the
changed files need. Add `pnpm check:ui` in the background when the change moves layout,
interaction or browser lifecycle. Build, embedded distribution, browser harness and
workflow changes also need `pnpm verify:full`.

Pull requests run the CI lanes their paths reach. Every push to `main`, the nightly run,
a manual run and the `full-ci` label run the full catalog, including the production SPA
and embedded Go binary build, browser and demo acceptance, and every probe. Release tags
are cut only from a commit whose `main` CI run is green.

Do not rerun a gate after each edit. When a check fails, rerun that check first.
[`AGENTS.md`](AGENTS.md) §5 defines the verification rules; [`docs/testing.md`](docs/testing.md)
says which layer owns a claim. The full command list is in [`AGENTS.md`](AGENTS.md) §8
and [`package.json`](package.json).

---

## Development Guidelines

### 1. Localization
User-facing strings must never be hardcoded in backend responses or React components. New copy arrives in all four languages at once: add the id to `web/src/i18n/locales/zh/<area>.ts`, then to `web/src/i18n/locales/en/<area>.ts`, and to `web/src/i18n/locales/zh-Hant.ts` and `web/src/i18n/locales/ms.ts`, which hold those two languages as one module each, then run `pnpm check-i18n`. Translators do not need to touch code: the catalogs are the whole surface.

### 2. Styling & Theme Tokens
- Never hardcode color hex values in components. Read the resolved palette from `web/src/theme/palette.ts` or use the CSS variables from `docs/design.md`; the eighteen derived tokens are computed, so reach for the relationship rather than re-deriving one.
- Oh My CPA uses a **terminal-flat** design language: zero box shadows (`box-shadow: none`), 4px border radii, and 1px hairline borders. Status colors (green, amber, red) are reserved strictly for semantic system health.

### 3. API & DTO Allowlisting
- The backend enforces strict DTO allowlists in `internal/api/`. Ordinary responses must not pass through raw, unsanitized CPA payloads. The trusted Plugin Host is the bounded native-response exception in ADR 0067, with credential separation, auditing, serialization and backups. Arbitrary target URLs remain forbidden.

---

## Contribution Workflow

Maintainers may push tested changes directly to `main`. Agents commit or push only when
the user asks. External contributors use a feature branch and open a pull request against
`main`:

1. Create a descriptive feature branch from `main`:
   ```bash
   git fetch origin main
   git switch -c feat/your-feature-name origin/main
   ```
2. Commit your changes with concise, conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`, `test: ...`).
3. Run `pnpm test:fast` and the additional checks the change needs, as described under
   [Verification Gates](#verification-gates).
4. Push your branch to your fork and open a Pull Request against `main`.
5. Pull requests are reviewed against [`.coderabbit.yaml`](.coderabbit.yaml), which points the reviewer at the invariants in [`AGENTS.md`](AGENTS.md). A non-draft pull request is reviewed once, when it opens; comment `@coderabbitai review` to request a later review. A release preparation pull request, titled `chore(release): prepare vX.Y.Z`, is exempt: the changes it describes were reviewed when they merged.
6. Fill in the pull request template ([`.github/pull_request_template.md`](.github/pull_request_template.md)): the problem and the solution, the context documents updated, and the gates that were run. Title the pull request `type(scope): lowercase subject`.
7. When your Pull Request is squashed and merged, GitHub will automatically append `(#<PR_NUMBER>)` to the commit title (e.g. `feat: add client key alias (#12)`), maintaining an auditable, linear history matching the project standard.
