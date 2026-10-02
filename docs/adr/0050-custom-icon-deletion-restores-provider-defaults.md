# ADR 0050: Custom icon deletion restores provider defaults

- Status: Accepted
- Date: 2026-10-02
- Supersedes: The reference-protection deletion policy in ADR 0049. Its asset storage, validation and branding decisions remain unchanged.

## Context

A shared asset may have several provider assignments, including legacy name-key overrides. Requiring operators to locate and change each assignment before deleting an unwanted icon makes library maintenance unnecessarily difficult. Simply deleting the artwork would leave dangling references, while substituting a fixed catalog ID would override the defaults appropriate to different provider families and plugin identities.

## Decision

Allow deletion of referenced custom icons after an explicit confirmation. The picker shows the asset, its current reference count and the consequence: all affected providers return to their normal default icon or placeholder. Cancel receives initial focus. Editing, library browsing and deletion confirmation remain views inside the existing picker rather than additional overlays.

The repository removes every exact `custom:<id>` override from the persisted `provider_icons` mapping and deletes the asset within one transaction. Unrelated assignments and preference keys remain unchanged. Asset deletion failure, missing assets and stale revision-bound approval roll back the entire reset. Preference writes continue validating custom IDs inside their own transaction, so concurrent selection/deletion cannot create dangling references.

Agent/MCP deletion stays destructive and high-risk. Its confirmation includes the reference count and default-reset impact, never artwork bytes; approval applies to the asset revision and resets all assignments present at execution time. Deletion invalidates both icon metadata and preferences. The picker mirrors only matching overrides into its shared preference cache, avoiding a whole-document refetch over unrelated optimistic edits, and clears any matching provider-drawer draft selection.

## Consequences

Operators can remove unwanted artwork without navigating to each provider. Removing an override preserves plugin authority and per-surface default resolution rather than freezing a catalog choice. Deletion permanently removes the asset and its assignments; recovery requires the existing database backup or importing artwork again. Reference counts are an explanatory snapshot, not a lock on assignments while confirmation is open.
