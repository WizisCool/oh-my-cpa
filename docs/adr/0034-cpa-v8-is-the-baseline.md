# ADR 0034: CPA v8 is the baseline; the console speaks the v8 Management API

- Status: Accepted
- Date: 2026-09-28
- Supersedes: [ADR 0028](0028-one-build-serves-cpa-v7-and-v8.md)

## Context

ADR 0028 made one build serve CPA v7 and v8 gateways: operations preferred the grouped
`/v8/management` routes and fell back to `/v0/management`, configuration placement
followed the stored file's layout, and OMC never performed a v8 configuration write so
that it would never trigger CPA's migration of the file. In practice the v8 routes were
rarely the ones exercised, every operation carried two routes and a fallback, and the
configuration editor carried a relocation table and a legacy-spelling fallback whose only
purpose was to keep v7 working. Its save guard is different: while the editors write
whole files through v0, it keeps CPA v8 from silently ignoring shadowed values or
replacing upstream provider groups, so it stays until those editors move.

Oh My CPA has not had its first release. Declaring the supported gateway range at that
release costs no existing deployment anything, while CPA v8 brings a declarative,
path-addressed configuration API (`GET/PATCH /v8/management/config`,
`/config/<section>/<field>`), upstream provider groups (`api-keys.<family>`), and one
shared OAuth login endpoint, which the console can build on directly.

## Decision

1. **CPA v8.0.0 or later is required.** The management client decides the API generation
   by reading `/v8/management/config/config-version` and requiring the value `8`, as
   before, but now as a gate: against a gateway that answers "not v8", every operation
   returns `management.ErrManagementV8Required` before any request is sent. CPA answers 404
   on every management path, v0 and v8 alike, while it has no management secret, so a
   missing v8 tree is confirmed against `/v0/management/debug`: when that is missing too,
   the gateway's Management API is disabled rather than old, and operations return
   `management.ErrManagementDisabled` instead. `/api/healthz` reports
   `cpa_management_api` (`v8`, `unsupported`, `disabled`, `unknown`), and the console
   replaces every page with upgrade guidance while it reads `unsupported`, or with the
   management-secret setting while it reads `disabled`. An undecided probe (unreachable,
   401, 5xx) blocks nothing, so the request fails with its own cause, and the gate does
   not probe again for `API_UNDECIDED_TTL`.
2. **Operations use the v8 routes only.** Credentials, OAuth, plugins, logs, usage,
   authenticated upstream calls, cooldown reset and release lookup are addressed at their
   `/v8/management` path. There is no fallback and no second route table.
3. **`/v0/management` is addressed only through `internal/cpa/management/client_v0.go`.**
   It holds the reads the v8 tree does not offer — the per-family credential lists are the
   only source of each upstream key's `auth-index`, which usage attribution, quota and key
   disablement are keyed by — and, until the editors that own them move, the
   configuration reads and writes.
4. **Configuration moves to the v8 configuration API.** The editors adopt v8 paths and
   write through `/v8/management/config` rather than replacing the whole YAML file. A v8
   configuration write migrates a legacy file; that migration is accepted, and OMC keeps
   a copy of the file as it was before its first v8 write. This is the target, not what
   this decision ships: until the editors move, OMC performs no v8 configuration write and
   the backup is not implemented.

## Consequences

- A v7 gateway is refused with one clear message instead of being served. Operators
  upgrade CPA first; CPA v8 reads a v7 file unchanged, so the upgrade itself needs no
  configuration change.
- Every operation is one request on one route. A v8 route that answers 404/405/501 drops
  the cached probe answer, so a gateway rolled back behind the same URL is re-probed and
  then refused by the gate.
- The capability-probe facade (`/api/v1/management/capabilities/{key}`) existed to tell an
  older CPA's missing endpoints apart from unwired UI. With a v8 baseline it has nothing
  to report and is removed.
- Moving the configuration editors is sequenced after this decision (decision 4); until
  then they keep ADR 0028's placement rules on v0, which a v8 gateway serves unchanged.
- The relocation table in `internal/cpa/configyaml/layout_rules.go` remains a snapshot of
  one CPA release while it is still used, and goes with the editor that uses it.

## Alternatives considered

- **Keep serving v7 (ADR 0028).** Rejected: it keeps two routes per operation and a
  configuration layer whose job is to avoid the v8 API, for a gateway range no release of
  OMC has promised.
- **Decide the generation from a version string.** Rejected for the same reason as in ADR
  0028: builds, forks and tags do not map reliably onto routes, while a route either
  answers or it does not.
- **Remove `/v0/management` entirely.** Rejected: the upstream keys' `auth-index` is only
  on the v0 credential lists, and dropping it would lose usage attribution, quota and key
  disablement for every configured API key.
