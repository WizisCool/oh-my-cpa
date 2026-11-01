# CPA integration contract

OMC requires CPA's v8 management API. A gateway can support v8 while still storing a
legacy-layout configuration file; these are independent facts. This guide covers the
integration boundary, not a second catalog of CPA settings or CPAMC features.

## Discover capabilities, not version guesses

[`v8_gate.go`](../internal/cpa/management/v8_gate.go) probes the configuration-version
endpoint and validates its value, not just a successful HTTP status. It distinguishes
an unsupported API from management disabled by a missing secret and from a transient
undecided probe. A known unsupported gateway returns `cpa_v8_required`; disabled
management returns `cpa_management_disabled`. Optional newer features are detected by
their actual endpoint/response behavior, not by inventing data when a field is absent.

Plugin login discovery follows the identifiers declared in the installed-plugin list,
bounded by the [plugin DTO projection](../internal/api/management_plugin_projection.go).
The [shared identity resolver](../web/src/types/pluginOAuthProviders.ts) distinguishes
login entries from their owning plugin's credential identity and branding, while retaining
older single-entry declarations. A plugin's installed page takes precedence over requesting
an interactive login; CPA still owns login execution and account matching.

The stored layout is read independently from the gateway's stored YAML before a
configuration write. Reads do not migrate it. The first v8 write can make CPA convert
a legacy file, including reformatting and handling unknown sections; preserve the exact
pre-write file before asking CPA to do that.

## Read and write boundaries

Ordinary browser responses are projections in [`internal/api`](../internal/api),
not native CPA payloads. Preserve absent, unknown, explicit zero and explicit false
where the upstream distinguishes them. Secrets use the dedicated audited reveal path;
provider and client-key identity must not depend on a masked display value.

Configuration editing uses the loaded revision and names only the paths the operator
changed. Serialize writers, validate the change set, keep the encrypted stored file,
then perform the upstream write and read back the result. Refuse a stale revision as
`config_conflict` and a rejected value as `config_rejected`; do not overwrite unrelated
settings to make the operation succeed. Restore also backs up the file it replaces.

A multi-path change can require several CPA calls (merge, map replacement, deletion).
It is not an upstream atomic transaction. Pre-write backup and honest failure/readback
reporting matter precisely because an earlier call can succeed before a later one fails.
Do not promise rollback that CPA cannot perform.

Provider credentials are edited within their v8 groups. Preserve group metadata,
unknown fields and sibling keys when changing one credential; array order is not
identity. Provider moves, regrouping and removals must retain the intended credential
and only its intended changes. Client access keys and upstream provider keys occupy
different configuration trees.

The trusted Plugin Host is a separate native-response boundary; its fixed origins,
credential separation, audit and write-backup requirements are in
[Architecture](architecture.md#trusted-plugin-pages). It is not permission to add
native responses to the ordinary facade or an arbitrary HTTP proxy.

## Credential recovery evidence

The credential facade and Agent reads share a bounded renewal/recovery projection.
Missing lifecycle fields remain unknown, not healthy. Quota reads, SIWC local status,
runtime adoption, successful inference and automatic renewal are independent evidence.
Refresh failure projection retains only allowlisted codes and an HTTP status, never
provider messages, OAuth codes, account profiles or native credential bodies.

Selected-credential sign-in resolves the name/index pair before asking CPA to pin the
account. Lifecycle fields are required evidence of support, and the auth-url response
must acknowledge the same target ID before OMC releases the login URL: a provider
handler can otherwise ignore the selectors even on a gateway with lifecycle fields.
Missing support, acknowledgement or endpoints must refuse recovery, never restart it
as ordinary login. CPA owns account
matching, exchange and persistence, including refusal of a different account.

Inference verification is a separate, explicitly confirmed token-consuming action;
post-login verification defaults to false. Both paths require audit admission before
execution. A completed sign-in is not proof of inference or automatic renewal, and a
failed summary read after completion is reported as a read failure, not a rolled-back
login. Recovery and verification remain operator-driven browser actions; Agent reads
receive the same safe evidence without OAuth interaction material.

## Where the live contract is defined

| Concern | Source |
| --- | --- |
| Endpoint handling and configuration changes | [`internal/cpa/management`](../internal/cpa/management) |
| Layout parsing, masking and lossless node edits | [`internal/cpa/configyaml`](../internal/cpa/configyaml) |
| Configuration editor fields and validation | [`web/src/components/config`](../web/src/components/config) |
| Credential discovery and stable identity | [`internal/cpa/discovery`](../internal/cpa/discovery) |
| Usage wire evidence and accounting | [`internal/usage`](../internal/usage) |
| Quota observations | [`internal/quota`](../internal/quota) |

Use these declarations and their owned fixtures when evaluating a new CPA release.
Read the upstream change and check the exact operation affected: optional reads,
field presence, credential grouping, revision conflicts, write preservation and
secrets. Extend the smallest existing contract case rather than maintaining a
spreadsheet of mirrored routes and version introductions.

## Structured request-usage evidence

The usage decoder retains the allowlisted structured observations published by CPA's
existing queue: modality and cache-TTL counters, cache and tool details, requested and
observed image settings, media counts, iterations, upstream costs and execution metadata.
[`structured_details.go`](../internal/usage/structured_details.go) owns the field schema
and capture bounds. Invalid or shortened observations set `is_partial`; an absent field
stays unknown, while explicit zero and false survive storage and projection. Named
TTL/tool counters are also allowlisted; unrecognized names make the capture partial
rather than opening a free-text export path.

Evidence is saved with the request in `usage_events.structured_usage`, follows request
retention, and is immutable after insertion. Historical rows remain NULL; no inbox replay
or backfill is implied. The single-request API and Agent/MCP `requests_get` expose bounded
typed projections. Lists and permanent aggregate facts do not acquire this detail payload.

These observations are independent of the canonical disjoint token partition. Iteration,
modality and cache-TTL counters must not be added to existing totals. Upstream-reported
amounts retain their published units and remain separate from OMC's locked price-book
estimate; they neither introduce tariffs nor reprice stored requests. Image settings
requested by a caller are not evidence of the settings observed upstream.

## Adoption and coexistence

Installing OMC must not rewrite or upgrade an existing CPA deployment implicitly.
Keep its files, auth directory, network topology and other panels intact. Operators
choose which process consumes usage: CPA's queue destructively distributes each
record to one reader, so two collectors lose complementary pieces of history.
Authentication probes must never pop the queue.

[Installation](install.md#other-panels-and-usage-trackers) covers coexistence choices.
[SQLite operations](ops/sqlite-operations.md) covers encrypted configuration copies
and manual recovery of legacy layouts. [Operations](operations.md) covers current
credential/quota controls and their limitations.
