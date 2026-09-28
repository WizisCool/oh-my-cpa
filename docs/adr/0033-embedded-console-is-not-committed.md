# ADR 0033: The embedded console is not committed; an unbuilt binary serves a placeholder

- Status: Accepted
- Date: 2026-09-28

## Context

`internal/web` embeds `internal/web/dist`, which `pnpm build` fills. Go's `go:embed`
refuses a directory with no embeddable file, and the Go tests request the console's
entry page, so a checkout that had not built the frontend needed something in that
directory. The repository committed the build's own `internal/web/dist/index.html` for
that purpose and ignored the rest of `dist/`.

That file is build output. Its script and preload tags carry content hashes, and the
entry hash moves whenever any module it reaches changes, lazy pages included. CI builds
the console and then requires a clean worktree, so almost every frontend pull request
had to run `pnpm build` and commit the regenerated file, and two branches doing so
conflicted on it. The committed copy was also never a working page: its assets are
ignored, so a binary built from a fresh clone served a document whose scripts 404.

## Decision

- **Nothing the build writes is committed.** `internal/web/dist/` is tracked only through
  `.gitkeep`, and `internal/web/embed.go` embeds it as `all:dist` so that file satisfies
  `go:embed`. `scripts/sync-web-dist.mjs` never prunes it.
- **An unbuilt binary serves a placeholder.** `web.IndexHTML` returns the build's
  `index.html`, or `internal/web/placeholder.html` when there is none. The placeholder
  is a real HTML document with a `<head>` and the runtime-configuration slot, so the
  server's injection and the Go tests behave the same with or without a build, and it
  tells an operator to run `pnpm build`.

## Consequences

- A frontend change no longer touches any committed generated file, and CI's
  clean-worktree checks keep guarding the files that are still generated and committed
  (the demonstration dataset, for example).
- The Go tests exercise the placeholder in the static job and the real entry page after
  a build. They must keep asserting only what both satisfy.
- `scripts/build-demo.mjs` detects a missing build by the entry document rather than the
  directory, which now exists in every checkout.
