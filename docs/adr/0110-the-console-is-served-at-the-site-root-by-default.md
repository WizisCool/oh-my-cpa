# ADR 0110: The console is served at the site root by default

- Status: Accepted
- Date: 2026-10-29

## Context

ADR 0001 made `/omc` the console's default mount. That default suited a shared hostname, but it made a plain Docker installation require a path suffix and every operator-owned reverse proxy carry a prefix rule. The console can already be embedded and served under any normalized `OMCPA_BASE_PATH`, so the prefix is a deployment choice rather than a requirement of the application architecture.

Existing deployments may have made that old default explicit in their Compose service or environment file, or may have relied on it implicitly through an older minimal example.

## Decision

New installations serve the console, API and media at `/`, `/api/v1` and `/media`. `OMCPA_BASE_PATH` remains the single configuration for deployments that intentionally need a sub-path, and the application, health check, Vite development server and embedded SPA continue to derive their URLs from it.

There is no permanent `/omc` alias or request-routing fallback. A deployment that configures `/omc` keeps that mount as an ordinary `OMCPA_BASE_PATH` value. Compose replacement and the updater preserve an explicit operator environment, so those deployments retain their URL and reverse-proxy rules.

A deployment that relied on the old implicit default without storing `OMCPA_BASE_PATH` must set it to `/omc` once before replacing the image if it needs to retain that URL. New installation examples set the root explicitly so a future default change cannot silently move them.

## Consequences

- A new installation is reachable at its host and port without a path suffix, and a root reverse proxy needs no prefix rewriting.
- Explicit sub-path deployments, including the old `/omc` value, remain supported without a special code path.
- Existing installations that used a release Compose file or updater keep their configured path. Installations copied from older minimal examples without the variable need the one-time explicit value.
- The site root is now the documented installation default; sub-path guidance describes a configurable deployment option rather than a legacy requirement.
