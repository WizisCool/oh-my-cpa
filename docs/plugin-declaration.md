# Plugin description declaration (v1)

A plugin may publish one small JSON document so a localized description is available
without asking a gateway per reader. The document carries descriptions only. Names,
logos, configuration and install metadata keep coming from CPA's plugin registry and
from the plugin's own registration, so nothing here can contradict what CPA already
shows.

This guide fixes what a plugin publishes. The reader that consumes it is defined by
the builtin-plugin routes in [`internal/api`](../internal/api) and the catalog in
[`internal/pluginregistry`](../internal/pluginregistry); their field lists are the
executable contract, not this prose.

## Where the document lives

A release publishes it under two addresses that must be the same bytes:

- the release asset `<plugin_id>.omc.json`;
- `GET /v0/resource/plugins/<plugin_id>/omc.json` from the loaded plugin, which CPA
  serves without management authentication.

Publish the file as UTF-8 JSON that is stable byte for byte across the release asset and
the resource CPA serves. Formatting is not part of the contract — the reader decodes the
document, it does not compare layouts — but keeping one file keeps the hash comparison
meaningful. CPA serves the resource route anonymously and release assets are public, so
the document must be safe to publish: descriptions and identifiers only, never
credentials, tokens, personal data or environment-specific URLs.

## Document

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer | `1`. A consumer that does not know the version ignores the document. |
| `plugin_id` | string | CPA plugin id, identical to the registry id and the asset file name. |
| `plugin_version` | string | Released version, no leading `v`, identical to the version in the archive name and the release tag without its prefix. |
| `i18n.description` | object | Descriptions keyed by locale. At least one entry is required. Only `zh`, `en`, `zh-Hant` and `ms` are accepted; any subset of them may be present, and each value is plain text of at most 8192 bytes without `<`, `>` or NUL and without control characters other than line breaks and tabs. |

The whole document is capped at 64 KiB. Decoding is strict: an unknown field or trailing
data rejects the document, it is not ignored.

```json
{
  "schema_version": 1,
  "plugin_id": "example-plugin",
  "plugin_version": "1.4.0",
  "i18n": {
    "description": {
      "en": "One sentence about what the plugin does.",
      "zh": "一句话说明插件的用途。"
    }
  }
}
```

v1 defines descriptions only. Menus, settings labels, actions and slots are
deliberately absent: a consumer must not read behavior out of this document, and adding a
field this version does not define rejects the document instead of extending it.

## How a description is resolved

A reader asks for one plugin at one version and reports the description it can justify,
tagged with where it came from. The origins are the reader's, not extra document fields:

| Origin | Source |
| --- | --- |
| `runtime` | the plugin's own resource route |
| `release` | `<plugin_id>.omc.json` on the release |
| `native` | the description CPA's registry already provides |
| `none` | nothing was available |

The locale chain is: the requested locale's entry, then `en`, then the registry
description. Only descriptions resolve this way — localized names and logos are out
of scope, and the registry description is never replaced by a translated one.

A document is treated as absent, leaving the registry description in place, when it
cannot be read, is not valid v1 JSON, or names a different `plugin_id` or
`plugin_version` than the installed plugin. A deployment where CPA serves no plugin
resources (Home mode) reads the release asset instead. None of these cases fail an
install or a plugin page.

## Version coupling

`plugin_version` moves with the release. A document written for one version and
served with another is a mismatch, not a fallback. Keep one source file in the
repository, bump it in the same change that bumps the registry version, and let
packaging copy it to the release asset unchanged so the asset and the served
resource cannot drift.
