# ADR 0031: Provider membership travels with the pricing catalog

- Status: Accepted
- Date: 2026-09-28

## Context

The Cost & Usage workbench must group models by the configured AI and OAuth providers operators manage. An OpenRouter author is a model maker, not necessarily the provider serving that model. Models may be available through several providers. Live per-credential discovery when the page opens would add network fanout and let partially failed reads misrepresent membership.

## Decision

Collect non-secret provider membership during the same complete CPA discovery sweep that resolves model aliases. Publish it atomically with the authoritative model catalog in `pricing_catalog_state.providers_json` through additive migration 029. A failed sweep retains the complete preceding snapshot. Read-time projections reuse management display-name/icon overlays and the console's existing provider defaults and plugin-owned logos.

API-key providers retain their management ids. Active OAuth credentials are grouped by provider, using the maximum credential priority for group ordering. A shared model appears under each configured provider but keeps one global price identity. Missing provenance is shown explicitly as unconfirmed instead of inferred from a model name. Conflicting alias targets remain valid catalog entries with an empty price target, which prevents automatic matching without blocking other models.

Provider groups sort by descending priority, then natural name and stable id. Within each group, model names sort naturally with case-insensitive primary ordering and uppercase-first case ties. One global page bounds all groups to 20 membership rows. Provider marks belong to group headings; model identity metadata retains an extension point for future model-directory ownership.

## Consequences

- Workbench reads stay local and survive CPA outages with the last complete snapshot.
- Membership can lag configuration until reconciliation; no incomplete live snapshot replaces it.
- The JSON snapshot adds no per-model price dimension and cannot rewrite historical costs.
- The existing `pricing_list` capability can expose membership for its bounded page without credential reads or new write permissions.
- Positional provider identities retain the same re-keying requirements as provider-management metadata.
