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

- **Go**: 1.25+ (pinned to `1.27.1` in CI)
- **Node.js**: 22+ (pinned to `22.23.2`)
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

Verification is structured around three moments — while editing, when a feature is
complete, and on the pull request. [`AGENTS.md`](AGENTS.md) §5 has the moments table and
the rules that keep the gates honest; [`docs/testing.md`](docs/testing.md) says which
layer a claim belongs in and how a new test is registered. In short:

```bash
pnpm test:fast    # while editing: only the checks the changed files need
pnpm verify       # feature complete, and before pushing
pnpm check:ui     # the browser scenarios the change can reach
```

Do not rerun a gate after each edit. When a check fails, rerun that check first. Both
UI probe commands use the dev server; production-artifact coverage comes from browser
and demo acceptance. The full command list is in [`AGENTS.md`](AGENTS.md) §8 and
[`package.json`](package.json).

---

## Development Guidelines

### 1. Localization
User-facing strings must never be hardcoded in backend responses or React components. Add all new strings as `[zh, en]` pairs to `web/src/i18n/index.tsx`, add the corresponding entries to `web/src/i18n/locales/zh-Hant.ts` and `web/src/i18n/locales/ms.ts`, and verify with `pnpm check-i18n`.

### 2. Styling & Theme Tokens
- Never hardcode color hex values in components. Read the resolved palette from `web/src/theme/palette.ts` or use the CSS variables from `docs/design.md`; the seventeen derived tokens are computed, so reach for the relationship rather than re-deriving one.
- Oh My CPA uses a **terminal-flat** design language: zero box shadows (`box-shadow: none`), 4px border radii, and 1px hairline borders. Status colors (green, amber, red) are reserved strictly for semantic system health.

### 3. API & DTO Allowlisting
- The backend enforces strict DTO allowlists in `internal/api/`. Ordinary responses must not pass through raw, unsanitized CPA payloads. The trusted Plugin Host is the bounded native-response exception in ADR 0067, with credential separation, auditing, serialization and backups. Arbitrary target URLs remain forbidden.

---

## Submitting a Pull Request

1. Create a descriptive feature branch from `master`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes with concise, conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`, `test: ...`).
3. Run the feature-completion gates before pushing (CI runs the full browser catalog):
   ```bash
   pnpm verify
   pnpm check:ui
   ```
4. Push your branch to your fork and open a Pull Request against `master`.
5. Pull requests are reviewed against [`.coderabbit.yaml`](.coderabbit.yaml), which points the reviewer at the invariants in [`AGENTS.md`](AGENTS.md). A non-draft pull request is reviewed once, when it opens; comment `@coderabbitai review` to request a later review. A release preparation pull request, titled `chore(release): prepare vX.Y.Z`, is exempt: the changes it describes were reviewed when they merged.
6. Fill in the pull request template ([`.github/pull_request_template.md`](.github/pull_request_template.md)): the problem and the solution, the context documents updated, and the gates that were run. Title the pull request `type(scope): lowercase subject`.
7. When your Pull Request is squashed and merged, GitHub will automatically append `(#<PR_NUMBER>)` to the commit title (e.g. `feat: add client key alias (#12)`), maintaining an auditable, linear history matching the project standard.
