# Contributing to Oh My CPA

Report bugs and feature requests through the [issue forms](.github/ISSUE_TEMPLATE/).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not upload production data, credentials, auth files or unredacted logs.

## Start locally

Use the toolchains pinned by [package.json](package.json), [go.mod](go.mod) and the
repository's tool-version files rather than version numbers copied into a guide.
Install Air if you want the Go watcher used by `pnpm dev`.

```bash
git clone https://github.com/<your-username>/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Before starting, fill the private `.env` with a new 32-byte hex `OMCPA_MASTER_KEY`
and your local CPA management key. Generate a master key with `openssl rand -hex 32`;
never replace the key for an existing data directory. CPA must already be available,
or be started separately with `pnpm cpa:start` after its local configuration is ready.
The default development console is `http://127.0.0.1:5173/`.

Builtin plugins follow the same official repository releases in development and
production. The publisher allowlist lives in [`internal/pluginregistry`](internal/pluginregistry).

The dev launcher starts a registry-only HTTP bridge so CPA can read the catalog
without exposing the management API. It uses loopback for a local CPA or, when
it can identify a locally published Docker CPA port, that container network's
host gateway. For a remote CPA, Docker Desktop, or an ambiguous network, set
`OMCPA_BUILTIN_REGISTRY_ORIGIN` to an origin reachable from both CPA and OMC and
serve the public registry there. Changing builtins from this development server
changes the connected CPA, so use a disposable gateway when experimenting.

## Find the relevant context

- [AGENTS.md](AGENTS.md): boundaries and a task-oriented guide map for all contributors.
- [CONTEXT.md](CONTEXT.md): project vocabulary.
- [Architecture](docs/architecture.md): ownership and trust boundaries.
- [Design](docs/design.md): UI composition and interaction principles.
- [Testing](docs/testing.md): test ownership, local checks and CI expectations.

Executable declarations own field lists, defaults and design-token values. Update the
one guide your change makes wrong; a feature does not require a new architecture
record, mirrored catalog or synchronized specification.

## Verify a change

Start with `pnpm test:fast`; use `--plan` to inspect affected-check selection.
`pnpm test:frontend` runs frontend tests, and `pnpm check:ui` exercises browser
behavior. Additional checks depend on the risk: see [Testing](docs/testing.md),
including shipped-build and release verification. Do not substitute a dev-server
pass for testing the embedded application.

Prefer a small regression in the lowest layer that can fail for the right reason.
Reuse existing cases and prove a bug test fails without the fix. Avoid duplicate
claims, assertion-free smoke tests and checks of prose or implementation details.
Fix timing and shared-state problems rather than adding sleeps, retries or skips.

## Submit

External contributors create a feature branch from `main` and open a pull request.
Maintainers may land tested work directly on `main`; agents commit or push only when
asked. Use focused commits, explain the behavior changed, and include verification
results and any limitations. Keep unrelated edits separate.

Use concise conventional commit subjects (`fix:`, `feat:`, `refactor:`, `docs:`).
A draft PR is useful for large work in progress. Automated review supplements the
repository checks and maintainer review; it does not replace either.

User-facing copy belongs in all four [locale catalogs](web/src/i18n/locales/) rather
than hardcoded in components. Follow the [copy guide](web/src/i18n/STYLE.md).
Technical prose and intent-focused code comments are English. Contributions are
licensed under the project's [MIT license](LICENSE).
