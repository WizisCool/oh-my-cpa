# Plugins

## Plugin store

The plugin store reads CPA's built-in `official` registry plus `plugins.store-sources`.
Oh My CPA's own registry is managed through **OMC Settings → Plugin store** or the
plugin sources list (`omc_plugin_source_enabled`, on by default). Both first-party
registries also list community code, so the console names each entry by who listed it
and who maintains its repository: a first-party registry's own publisher (`omc-community`
for Oh My CPA, `router-for-me` for CPA) installs after one confirmation; every other entry
requires typing the plugin ID to confirm running code inside the gateway.

## Plugin pages

Installed plugin pages open through OMC's authenticated same-origin host; CPA does not
need to be reachable from the browser. Treat installation as granting trusted code access:
native management responses can include configuration credentials, and a page written for
CPAMC reads the gateway credential from browser storage, where the console mirrors it
before the page loads. Sign-out, a refused session check and the next sign-in withdraw it.
Configuration-affecting
calls through the Plugin Host are audited, serialized and backed up. See
[Architecture](../dev/architecture.md#trusted-plugin-pages) for fixed-origin and header boundaries.
