# ADR 0014: Plugin branding does not depend on the plugin's enablement

- Status: Accepted
- Date: 2026-09-19

## Context

ADR 0013 decision 1 named the plugin as the authority on its provider's mark, and then added a clause
of its own: *"Only an effectively-enabled plugin contributes."* The premise behind that clause was that
a disabled plugin cannot hold credentials, so a logo for it would only decorate a name the operator
cannot use.

The premise is wrong, and the merged change showed it. Disabling a plugin in CPA flips
`plugins.configs.<pluginID>.enabled`; it does not delete the auth files that plugin registered. Those
credentials keep appearing on the OAuth-management, quota and request-record surfaces, where the mark is
asked for by provider key. The dashboard's own provider-id set (`pluginOAuthIds` in
`web/src/components/dashboard/DashboardProviders.tsx`) never gated on enablement either, so a disabled
plugin's provider was listed beside one whose mark resolved — with a placeholder where the plugin's own
artwork belongs. That is the defect ADR 0013 exists to remove, reintroduced by a clause inside it.

A code review of the merged change raised it (`web/src/types/pluginOAuthProviders.ts`), and it was
verified against the code rather than accepted on the reviewer's word: the filter is the only gate on
that path, and nothing else in the console excludes a disabled plugin from those surfaces.

## Decision

**Branding is a property of the provider's identity, not of the plugin's current switch state.**
`pluginOAuthProviderLogos` contributes the published logo for every plugin that registers an OAuth
provider, whether or not that plugin is enabled, and the mark is resolved by provider key wherever the
provider appears - including on rows that belong to credentials, and to request records, committed while
the plugin was enabled.

Excluding a disabled plugin remains where the plugin's **actions** live, which is the OAuth sign-in
page's card builder, and it is unchanged there: a disabled plugin offers no login.

This supersedes the *"Only an effectively-enabled plugin contributes"* clause of ADR 0013 decision 1.
ADR 0013's decision 1 otherwise stands, as do its decisions 2 to 4 - the process still fetches and
inlines the logo, a plugin-declared URL is still held to the stricter destination policy, and the plugin
list is still projected into the console's own DTO.

## Consequences

- A credential belonging to a disabled plugin's provider, and a historical request answered by one, draw
  that plugin's own mark instead of a placeholder. That is the point: the mark identifies the provider
  behind the row, and it does not become false when the plugin is switched off.
- The logo is resolved for a plugin the operator has switched off, so the deployment may fetch artwork
  for a plugin it is not using. The fetch already happened for every installed plugin before this
  decision - it walks the plugin list, which enablement does not filter - so the change is in what the
  console *draws*, not in what the process reaches for.
- An operator who disables a plugin to put it aside still sees its mark on historical rows. Hiding those
  rows is a different question, and answering it with a branding rule would have been the wrong tool.
- `scripts/test-provider-icons.ts` pins both directions: a plugin disabled through its own switch or
  through the global one still names its provider, while a plugin that declares neither `supports_oauth`
  nor `oauth_provider` contributes nothing.

## Alternatives considered

**Keep the filter and accept a placeholder on rows whose plugin is disabled.** Rejected: it is the
reported defect itself, and it makes the console disagree with its own dashboard, which lists that
provider either way.

**Drop a disabled plugin's credentials and records from every surface.** Rejected: those are historical
facts, not configuration - a record of a request that happened does not stop having happened because a
plugin was later switched off. Changing what history is shown is a separate decision from which mark a
row wears.

**Gate on `registered` instead of `enabled`.** Rejected: `registered` reports whether the dynamic library
loaded in this process, which is a statement about the plugin's runtime, not about whether its provider
has credentials or history. It would produce the same disagreement with the surfaces that list them.

**Treat enablement as an operator intent that should hide the brand too.** Rejected: the operator
switches a plugin off to stop *using* it. The mark on a credential or a past request is not an
invitation to use anything, and removing it costs the operator the ability to tell whose account a row
belongs to.
