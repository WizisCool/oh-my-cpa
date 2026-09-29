# ADR 0038: Upstream credentials are written as v8 groups

- Status: Accepted
- Date: 2026-09-29
- Completes: [ADR 0034](0034-cpa-v8-is-the-baseline.md), decision 4, after
  [ADR 0037](0037-configuration-editing-uses-the-v8-configuration-api.md)

## Context

After ADR 0037 the configuration page, its source view and the Keys page wrote through
the v8 configuration API, but three editors still wrote through `/v0/management`:

- the provider pages, which read a family's credential list (`/<family>-api-key`,
  `/openai-compatibility`), edited it and wrote the whole list back;
- the OAuth model aliases (`PATCH /oauth-model-alias`);
- per-plugin enablement and settings (`/plugins/<id>/enabled`, `/plugins/<id>/config`).

CPA v8 stores upstream credentials as groups. `api-keys.<family>` is a list of
`{name, base-url, shared settings, keys: [...]}`, and a key may override any shared
setting except `base-url`. CPA's runtime view, which is the v0 list, is those groups
flattened into one entry per key, in order, each with its `auth-index`. The console
addresses providers by their position in that list. Usage attribution, quota and key
disablement are keyed by the `auth-index`, and only the v0 list carries it.

A v0 list write discards the operator's grouping: CPA regroups the written family as
one group per entry, named `<family>-<n>`, and loses the group names and shared settings.
A v0 write to a pre-v8 file also bypasses the backup ADR 0037 takes before a conversion.

Measured on CPA v8.0.2:

- A key may override a group's `models`, `priority`, `excluded-models`, `disable-cooling`
  and `request-retry`, including with a zero value (`models: []`, `priority: 0`).
- `PATCH /v8/management/config` with `{"api-keys": {"claude": [...]}}` replaces that
  family and keeps the others.
- `plugins.configs.<id>` and `oauth.model-alias.<provider>` are ordinary paths:
  `PATCH`, `PUT` and `DELETE` work on them.

## Decision

1. **Every configuration write uses the v8 configuration API.** It goes through the
   change set of ADR 0037, which keeps a pre-v8 file before converting it. The remaining
   `/v0/management` calls are reads (`client_v0.go`): the per-family lists, for each
   key's `auth-index`, and the stored file, for the backup.
2. **A provider write edits the file's own values and returns them to their groups.**
   `EditableConfigAPIKeys` reads the v0 list, which supplies positions and `auth-index`,
   and the family's stored groups. It matches the stored keys to the runtime entries in
   order, by API key and base URL. Each entry therefore carries the stored settings and
   the group it came from.
   `UpdateConfigAPIKeys` writes the family back as groups, in the list's exact order:
   - A setting the group stores takes the value its keys now agree on, or keeps its
     stored value when they disagree.
   - A key that differs states its own value, and a cleared value is its zero where
     CPA reads absence as zero.
   - A key its group cannot express moves to a group of its own named after the
     original. That is a key with another base URL, or one that cleared a pointer
     setting (`disable-cooling`, `request-retry`) where only absence means "inherit".
     The keys after it continue in a group with the same settings.
   - A new provider is a new group.
3. **OpenAI-compatible providers are written as one group per provider.** Their keys go
   under `keys`, and the unmodelled settings of each provider, key and model are carried
   through.
4. **OAuth model aliases and plugin settings write their own paths:**
   - `oauth.model-alias.<provider>`, removed when the list is empty, together with any
     other spelling of the same provider;
   - `plugins.configs.<id>.enabled`;
   - `plugins.configs.<id>`.
   The alias read applies CPA's own cleanup, so the console shows what the gateway uses.

## Consequences

- An edit through the console keeps the operator's group names and shared settings. An
  untouched family is written back exactly as stored.
- The first provider, alias or plugin write to a pre-v8 file converts it, after the same
  backup as a configuration save.
- A stored key that CPA's runtime leaves out is not part of the editable list, so a
  write drops it. Examples are a duplicate, or a key without the base URL its family
  requires. A whole-list v0 write dropped it too.
- An edit starts from the stored entry, so a key's and a model's settings the form does
  not show are kept, and a family default base URL the runtime reports is not written
  into a key the file stores without one.
- A provider write sends every key of its family, including one only that request adds,
  and CPA's reason for a refusal can quote a value. The reason is scrubbed of the
  stored file's secrets and the sent ones before the response or the audit log sees it.
- A key whose base URL changes moves out of its group, so the file can gain a group
  named `<group>-<n>`. The list's order, and so every provider id, is unchanged.

## Alternatives considered

- **Keep the v0 list writes.** Rejected: they regroup the whole family on every write and
  convert a pre-v8 file without a backup.
- **Edit groups in the console.** Rejected for now: every provider id, overlay and usage
  join is positional in the flattened list. Introducing groups there changes the provider
  model rather than its storage, and nothing the operator does today needs it.
- **Write one group per entry.** Rejected: that is exactly the v0 behaviour and discards
  the operator's grouping.
