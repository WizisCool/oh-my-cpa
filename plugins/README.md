# Oh My CPA plugin registry

This directory publishes Oh My CPA's own plugin registry, which the console keeps
configured as a plugin-store source. CPA reads it over HTTPS from the `master`
branch:

```
https://raw.githubusercontent.com/WizisCool/oh-my-cpa/master/plugins/registry.json
```

The address is compiled into the binary (`internal/pluginregistry`), not configured
in `config.yaml`; the console adds it to `plugins.store-sources` and restores it if
it is removed there. The source can be switched off under **Settings → Plugin
store**, which removes the address again.

## Format

The file is CPA's plugin registry document. `schema_version` is `1` or `2`; version
2 additionally allows `install.type: direct` with per-version artifacts. Every entry
declares the fields CPA validates:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, unique in the file |
| `name` | yes | Shown on the store card |
| `description` | yes | One sentence is enough |
| `author` | yes | |
| `repository` | yes for `github-release` | `https://github.com/{owner}/{repo}` exactly: the store builds release URLs from it and refuses an `owner/repo` shorthand, a `.git` suffix, or any other host |
| `version` | optional | Display fallback; the latest release is authoritative. No leading `v` (that belongs to the tag) |
| `homepage`, `license`, `tags`, `logo` | optional | `logo` is a URL the console inlines |

An empty `plugins` list is valid: the registry is published before the first plugin
exists, so the store has a working source rather than a failing one. One malformed
entry is not: CPA refuses the whole document, so every installation shows an empty
Oh My CPA registry and only the gateway's error line. The Go tests in
`internal/pluginregistry` validate the published file (`pnpm test:fast` runs them when
the registry changes) for that reason.

Entries are curated here, not discovered. A plugin installed from this registry
still needs its id typed in the install dialog: the confirmation is about running
code inside the gateway, not about which registry supplied it.
