# Contributing to Oh My CPA

Thank you for your interest in contributing to Oh My CPA! We welcome bug reports, feature suggestions, documentation improvements, and code contributions.

---

## Code of Conduct & Ground Rules

- **Zero Secret Exposure**: Never submit real API keys, tokens, auth files, or sensitive production data in pull requests, issues, or commit history.
- **Explain Why, Not What**: Code comments must be written in **English** and focus on design rationale, non-obvious constraints, and edge cases.
- **Synchronize Docs with Code**: Documentation and code are co-deliverables. If your change alters an endpoint, configuration, UI token, or architectural boundary, you must update the corresponding context documents in the same pull request (see [`AGENTS.md`](AGENTS.md)).

---

## Getting Started

### Prerequisites

- **Go**: 1.24+ (pinned to `1.24.13` in CI)
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
   This launches Air (watching Go backend on `:8080`) and Vite (frontend dev server on `:5173`) concurrently. Access the console at **`http://127.0.0.1:5173/omc/`**.

---

## Verification Gates (Three Verification Moments)

To keep feedback fast and reliable, verification in Oh My CPA is structured into three stages (detailed in [`AGENTS.md`](AGENTS.md)):

| Stage | Command | When to Run |
| --- | --- | --- |
| **Development iteration** | `pnpm test:fast` | Run frequently after editing code. It runs only the checks affected by your current working tree changes (1–13s). |
| **UI fast-path** | `pnpm check:ui` | Run when modifying frontend components, layout, or browser lifecycles (runs against dev server + mock APIs without full build). |
| **Feature completion** | `pnpm verify` | Run before committing and opening a PR. Covers toolchain verification, Go vet/tests, frontend type checking, pure logic suites, antd lint, i18n validation, and secret scanning (~22s). |
| **Full gate** | `pnpm verify:full` | Full pre-merge validation including production build, bundle budget verification, and deterministic browser acceptance + probes (~95s). |

Additional targeted checks:
- `pnpm check-docs`: Validates that all backticked repository paths in documentation resolve and no retired references exist.
- `pnpm check-i18n`: Identifies missing source keys and incomplete or stale locale catalogs.
- `pnpm check-css-modules`: Ensures CSS module class references match their definition files.

---

## Development Guidelines

### 1. Localization
User-facing strings must never be hardcoded in backend responses or React components. Add all new strings as `[zh, en]` pairs to `web/src/i18n/index.tsx`, add the corresponding entries to `web/src/i18n/locales/zh-Hant.ts` and `web/src/i18n/locales/ms.ts`, and verify with `pnpm check-i18n`.

### 2. Styling & Theme Tokens
- Never hardcode color hex values in components. Import from `palette` in `web/src/theme/themeConfig.ts` or use CSS variables from `docs/design.md`.
- Oh My CPA uses a **terminal-flat** design language: zero box shadows (`box-shadow: none`), 4px border radii, and 1px hairline borders. Status colors (green, amber, red) are reserved strictly for semantic system health.

### 3. API & DTO Allowlisting
- The backend enforces strict DTO allowlists in `internal/api/`. Responses must never pass through raw, unsanitized CPA payloads or arbitrary proxy responses.

---

## Submitting a Pull Request

1. Create a descriptive feature branch from `master`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes with concise, conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`, `test: ...`).
3. Ensure all static checks pass:
   ```bash
   pnpm verify
   ```
4. Push your branch to your fork and open a Pull Request against `master`.
5. Pull requests are reviewed against [`.coderabbit.yaml`](.coderabbit.yaml), which points the reviewer at the invariants in [`AGENTS.md`](AGENTS.md).
6. Clearly describe the problem, the solution, and any documentation updated in your PR description.
7. When your Pull Request is squashed and merged, GitHub will automatically append `(#<PR_NUMBER>)` to the commit title (e.g. `feat: add client key alias (#12)`), maintaining an auditable, linear history matching the project standard.
