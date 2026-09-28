# ADR 0029: Plugin management owns the plugin system settings

- Status: Accepted
- Date: 2026-09-28

## Context

Plugins were two console pages and a configuration group. `/plugins` listed what was
installed, `/plugin-store` listed what could be installed, and the switch that decides
whether CPA loads any plugin at all (`plugins.enabled`), the extra store registries
(`plugins.store-sources`) and the store authentication rules (`plugins.store-auth`)
lived under the configuration page's advanced section - the rules as a raw JSON editor.
Finding a plugin, installing it, configuring it and switching the system on crossed
three places, and the last step was the least discoverable one.

The facade behind the two pages had also drifted from the gateway it fronts. It decoded
fields CPA's plugin list does not carry (a top-level name, description, permissions and
the configuration document), toggled a plugin through a route CPA does not serve, and
read nothing of what CPA does send: the global switch, each plugin's declared
configuration fields, the registry a store entry came from, its tags, icon, homepage
and whether an update is available.

CPA offers no narrower management route for the three host settings. They are keys of
`config.yaml`, readable and writable only as the whole document.

## Decision

1. **One page.** `/plugins` carries three tabs - installed, store, settings - selected by
   `?tab=`. `/plugin-store` is a compatibility redirect to `/plugins?tab=store`, and the
   configuration page no longer shows the plugin group.

2. **The facade speaks CPA's real plugin API.** The list, the per-plugin switch
   (`PATCH /plugins/{id}/enabled`), the per-plugin settings document
   (`GET`/`PUT /plugins/{id}/config`), removal and the store with installation from a
   named registry at a named version. Responses are projected into this console's own
   DTOs; the repository link and whether an entry is first-party are derived on the
   server, so every surface reads the same answer. A store entry is official only when
   CPA's built-in registry supplied it *and* its repository is under the first-party
   GitHub organisation, because a third-party registry can copy a repository name.

3. **The host settings are edited in the document, server-side.**
   `PUT /api/v1/management/plugins/settings` reads `config.yaml`, rewrites only
   `plugins.enabled`, `plugins.store-sources` and `plugins.store-auth` (comments and
   every other key, `plugins.dir` and `plugins.configs` included, are kept), and writes
   the document back. It is the same transaction a configuration save is: it holds the
   provider write gate and the configuration mutex, and it carries the revision the page
   loaded, so a change made elsewhere in between is refused as `config_conflict` rather
   than overwritten. Rules are validated the way CPA reads them, and only the environment
   variable names a rule's type uses are written.

4. **A plugin's declared fields are the editor.** The settings drawer renders each field
   CPA reports as a typed control, marks what the draft changed, and lets a field be
   cleared back to the plugin's default. Keys the plugin does not declare are carried
   through untouched and shown; the JSON view edits the same document.

## Consequences

- The console now writes `config.yaml` from a second place. The revision check and the
  shared write gate are what keep that safe, and they are the reason the write is not
  done in the browser by patching the configuration page's draft.
- The browser never learns a store credential: a rule names environment variables, and
  CPA reads the values from its own environment when it makes the request.
- A registry's icon is fetched and inlined by the server under the same rules as an
  installed plugin's logo (ADR 0013), so the store adds no browser request to a
  third-party host.
- The store is read only once its tab is opened: reading it makes CPA fetch every
  registry and, for installed plugins, their latest releases, which is slow and rate
  limited, and the installed list must not wait on it.
