# ADR 0061: Model Square uses bundled models.dev reference facts

- Status: Accepted
- Date: 2026-10-05
- Related: ADR 0030 (pricing source), which remains unchanged

## Context

Model Square replaces the available-model-list role of CPAMC's Center Information.
Operators need a simple directory of callable names and useful specifications when
selecting a model. CPA is the availability authority but does not publish a complete
specification, licensing or weight-reference database. Pricing records are unsuitable
for these facts: an exact routing target may have no price, and reseller context or
costs must not redefine canonical model capabilities.

The console must remain self-contained and usable offline. A browser fetch to a third
party would introduce availability, privacy and content-security dependencies merely
by opening a management page.

## Decision

1. CPA's live `/v1/models`, authenticated with the first configured nonempty client key
   server-side, defines which model names are listed. Configuration supplies only safe
   provenance for advertised names. No model catalog can expand this set.
2. `internal/modelcatalog` embeds a models.dev canonical snapshot with exact,
   unambiguous source aliases. `pnpm models:sync` updates it from fixed models.dev URLs
   during maintenance, not at runtime. Reseller costs are excluded. Pricing continues
   to use its existing OpenRouter source.
3. Evidence is only an exact canonical identity or source-declared alias. A name with
   neither is retried in a closed set of forms that denote the same model - without a
   router tag, without one enumerated request-variant suffix, without leading routing
   namespaces - each of which must match exactly, the literal name first. Ambiguous or
   absent matches remain unknown; version/family similarity never fills specifications.
   A shared call point can expose several independently identified profiles.
4. Open-weight status, license and weight links are separate facts. A model is called
   open-source only when published weights carry a recognised open-source license; an
   open weight flag or a download link alone does not establish one. Reference token
   limits do not guarantee the limits a particular connection enforces.
5. The default page groups client model names vertically by maker and offers search.
   A Back-aware Drawer shows facts and explicit models.dev, OpenRouter and pi.dev
   navigation. External references open only on user action with opener/referrer
   protection; all icon artwork is local.

## Consequences

Offline deployments receive useful model details without a new service, database
migration or background loop. Metadata freshness follows the release snapshot and is
visible in the page. New or custom model IDs can remain unmatched until the source
publishes an identity and maintenance updates the snapshot; lookup links still work.
The source's MIT notice is retained alongside the embedded dataset. Demo data must be
regenerated when that dataset changes.
