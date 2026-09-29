# ADR 0028: One build serves CPA v7 and v8, placing settings by the file's layout

- Status: Superseded by ADR 0034
- Date: 2026-09-27

## Context

CPA v8 moved most configuration settings into new sections and gave the root
`api-keys` key a new meaning (upstream provider groups instead of client keys). It
still reads a v7 file unchanged, keeps the whole `/v0/management` API, and adds a
`/v8/management` tree. A v8 configuration write migrates and rewrites the whole file.

Against a migrated file, OMC's configuration editor and Keys page wrote v7 paths
through `PUT /v0/management/config.yaml`. CPA accepted the save, answered success, kept
the v8 value and deleted the edit. Writing the client-key list at the root also deleted
every upstream provider credential. Nothing in the response revealed either loss.

Deployments will run both generations for some time, and one OMC build has to serve
both without an operator switch.

## Decision

1. **Detect, never compare versions.** The API generation is decided by reading
   `/v8/management/config/config-version` and requiring the value `8`. The file's
   layout (`legacy`, `v8`, `mixed`) is decided from the document itself. Both facts are
   exposed to the console, and the API generation is also a capability key
   (`management-v8`).
2. **Placement follows the document, not the gateway.** A legacy file is edited at v7
   paths on either gateway; a v8 or mixed file at v8 paths, with the legacy spelling read
   as a fallback and removed on write. OMC never performs a v8 configuration write, so it
   never triggers the migration on the operator's behalf.
3. **One relocation table, CPA's own.** The table is taken from CPA's source
   (`internal/cpa/configyaml/layout_rules.go`) and sent to the console with the
   configuration, so the editor and the server-side guard read the same rows.
4. **Refuse what CPA would silently drop.** Unless the gateway is known to lack the v8
   API, a whole-document save that contains a legacy spelling beside its v8 twin, or that
   replaces stored provider groups, is refused before it reaches CPA.
5. **Operations prefer v8 routes only where v8 reuses the v0 handler**, and fall back
   to v0 when the v8 route is missing. Everything else stays on v0.

## Consequences

- A v7 gateway sees exactly the requests it saw before, apart from one cached probe.
- The table is a snapshot of one CPA release and must be re-derived when the pinned
  release changes (`docs/cpa-v8-compat.md` §10). A setting CPA moves in a later release
  is not placed by the editor, nor checked by the guard, until then.
- The guard can refuse a document a human wrote on purpose with both spellings. The
  refusal names each pair, and removing one spelling resolves it.
- Operations on the fallback path cost one extra request when a v8 route answers 404
  for its own reasons (an unknown id).

## Alternatives considered

- **Migrate the file through `/v8/management/config`.** Rejected: it rewrites the
  operator's whole file (formatting, unknown sections turned into comments) as a side
  effect of editing one setting, which contradicts the adoption invariant that OMC never
  mutates configuration it does not own.
- **Write every setting through path-addressed v8 endpoints.** Rejected for the same
  reason: any successful v8 write migrates the file.
- **Choose placement by gateway version.** Rejected: a v8 gateway serving a legacy file
  would have its file migrated piecemeal into a mixed layout.
