# Agent capabilities

The console's **Agent** page (`/agent`) and the `oh-my-cpa mcp` stdio bridge both drive
Oh My CPA through one capability registry. This document is the contract for adding to
it; see `docs/adr/0026-one-capability-registry-over-shared-operations.md` for why the
registry exists in this shape.

## Shape

```text
Agent page ──▶ internal/agent.Runtime ──▶ CPA gateway (model + tool calls)
                      │
                      ▼
                internal/capability.Executor
                      │  validate → authorize → confirm → audit
                      ▼
                internal/operations.Service
                      │
        repository / pricing / quota / management client
```

- `internal/operations` holds the business operations. A console HTTP handler and a
  capability call the same method; neither re-implements validation, write gates,
  revisions, or CPA readback.
- `internal/capability` owns declarations, JSON Schema inference, argument and result
  validation, permission and risk rules, the pending-operation store, and the audit
  trail.
- `internal/agent` owns the model loop: conversation persistence, budgets, streaming,
  and resumption, plus the two things that belong to the conversation rather than to OMC -
  `ask_question` and the display tools. It never touches the database, configuration, or
  the CPA client directly. The console reaches it over AG-UI (`internal/agui`, ADR 0041).
- `internal/mcpbridge` maps the registry to MCP tools for external agents. It carries no
  business logic and no approval policy.

## Declaring a capability

### What the model is offered

Every registered capability is declared to the model as a tool from the first round of
every turn, in name order, with its description and inferred input schema. Discovery is
not a step: gating the tool list behind a search and loading a subset per conversation is
the obvious way to shrink a request, and it costs one whole model round trip before any
work can start - while making "the agent does not do this" indistinguishable from "the
agent has not been told about this yet".

The consequence to keep in mind when adding capabilities is the opposite of the usual one:
**the catalogue is paid for on every model call of every turn**, so a long description is a
recurring cost rather than a one-off. A declaration is bounded by
`agent.MAX_TOOL_SCHEMA_BYTES` (32 KiB) and the whole request by `agent.MAX_CONTEXT_BYTES`
(128 KiB); a definition that pushes the catalogue past the first is a startup-time problem,
not a runtime one, and the runtime refuses the turn rather than truncating the list.

The system prompt is paid for the same way. It is built from named sections in
`internal/agent/prompt.go` - identity, approach, data, safety, presentation, context - bounded by
`agent.MAX_PROMPT_BYTES` (6 KiB), and every turn records the `agent.PROMPT_VERSION` it ran with.
A capability's guidance belongs in its `Description`, where it is paid for only by the tool that
needs it; a rule that holds across capabilities belongs in one section, and changing a section's
wording bumps the version.

A declaration is one call to `capability.Register` with:

| Field | Meaning |
| --- | --- |
| `Name` | Stable `snake_case` adapter-facing tool name; duplicates fail startup |
| `Description` | What the tool does and what it does not reveal; shown to the model |
| `Version` | Incremented when a pending operation's meaning changes |
| `Permission` | `read`, `write`, or `destructive` |
| `Risk` | `low` or `high`; `high` requires a prepare function and human confirmation |
| `HumanInput` | Optional browser handoff: `secret` or `oauth` on a `high` risk write, or `answer` on a read that waits for the operator's reply (`ask_question`) |
| `Adapters` | `agent`, `mcp`, or both; exposure is explicit, never implied |
| `Invalidates` | React Query keys the UI should refresh after a successful write |

The handler receives a typed input struct. The registry infers the input and output JSON
Schemas from those types, validates arguments against them (unknown fields are
rejected), re-validates the raw arguments at execution time, and validates the typed
result before it reaches a model. Both payloads are capped at 32 KiB.

### Read capabilities

Reads execute immediately and return their validated result. They must aggregate or
paginate on the server: a bounded page, a bounded group count, or a summary, never a
whole table. Follow the existing budget conventions - 20 rows per request page (100
maximum), 50 groups with the remainder folded into `other`, 120 trend buckets.

### Write capabilities

Low-risk writes (display-only metadata such as a client-key alias) may execute
automatically. Everything that changes routing, credentials, availability, or
configuration is `high` risk and goes through the executor's confirmation flow:

1. The model calls the tool.
2. The `Prepare` function reads the current state and returns a structured preview:
   `Target`, `Revision` (the identity and version the approval is bound to), and
   `Changes`.
3. The executor stores the pending operation encrypted, writes a `prepared` audit
   event, and returns `{status: "pending", operation_id: ...}` to the caller.
4. The Agent's run finishes with an AG-UI interrupt naming the operation and the call that
   raised it. The console draws an approval card under that call (ADR 0043), and a signed-in
   operator makes one decision: allow or deny (ADR 0035). Approval re-validates the
   capability version, the caller's authority, and the resource revision inside the same
   write gate that performs the change; deciding resumes the Agent's run without a separate
   step.
5. The result is recorded (`success`, `partial`, `error`, or `uncertain`) and audited.
   An operation is consumed once; a repeated approval returns the stored outcome.

Rules that are not optional:

- A destructive capability is marked `destructive`, which the approval card states as an
  irreversible change. A batch operation must show the resolved target list and its
  count, and must never expand a wildcard at execution time.
- The approval is bound to the revision captured by `Prepare`; if the target changed,
  the executor returns `resource_conflict` and the operator must re-confirm.
- A write that may have reached CPA but cannot be verified is reported as `uncertain`
  (`operation_outcome_unknown`), never as a plain error and never retried
  automatically.
- A write whose result fails output validation is also `uncertain`, because the change
  may already have been applied.

Pricing is the worked example of a revision-bound write. `pricing_set` decides how
one model is priced (`auto`, `linked` to an OpenRouter id, or `custom` rates with
optional tiers) and `pricing_channel_set` sets one channel multiplier; both are `high`
risk and are bound to the revision of the current price list or channel list, so an
edit made in the console between preparation and approval returns `resource_conflict`.
`pricing_delete` and `pricing_channel_delete` are destructive. None of them reprices a recorded request (ADR 0030).

A refusal the caller can correct says what to change. `operations.invalidParameters`
keeps the stable `invalid_parameters` code and implements `capability.DetailedError`,
and the executor returns a detailed refusal raised by `Prepare` as an `error` result
with that `detail` instead of a bare failure - on both adapters, before any pending
operation or approval exists. Pricing uses it for every rejected rate, tier, zone,
mode and OpenRouter id; reuse it rather than returning a bare code from a new
capability whose arguments an agent could plausibly get wrong.

### Asking the operator

`ask_question` is the one capability that belongs to the conversation rather than to OMC:
`internal/agent` registers it, for the built-in Agent only. The model asks 1-4 questions in one
call, each with 0 or 2-6 labelled options (single or multiple choice), and the operator can always
type an answer instead. It is a `read` with `HumanInput: "answer"`: the executor stores it as a
pending operation that expires after 24 hours, the console draws it in place of the composer, and
the operator's answer is validated against the questions before the operation is claimed, so a
malformed answer leaves it open. The model receives each question with the chosen labels and typed
text; Skip is a `rejected` result. It is not a way to ask for approval (writes already ask) or for
secrets.

### Display tools

`render_chart` and `render_table` are how the Agent shows data rather than retelling it (ADR 0042).
`internal/agent` owns them, and they are offered only when the client declares that it can draw
them - the console does, the MCP bridge does not. They are not capabilities: they change nothing,
never pass through the executor and never interrupt a run.

The model references the rows of an earlier capability result by `source {call_id, path}`; the
server resolves the reference, projects and checks the named fields, freezes the dataset on the
call's trace, and returns a receipt (`rendered`, `rows`, `fields`) instead of the rows. `inline` rows
(at most 200) are for figures the model derived itself. A refusal is an `invalid_tool_arguments`
result whose detail names the field to change. Views are bounded to 1000 rows, 12 table columns,
8 chart series and 96 KiB. A category axis keeps its labels horizontal and ellipsised; the tooltip carries the full value.

Displays are selective final-answer artifacts, not progress reports: the model investigates and verifies before preparing one, uses the smallest complementary set, and leaves exploration in the trace. The console publishes a frozen view only from a successful turn, in a result section after the answer; earlier or unsuccessful work stays inspectable in the call details.

What this means for a new capability: a result that holds its rows as an array of objects with
scalar fields - or, like `database_query`, as positional arrays beside a `columns` list - can be
charted and tabulated with no further work. A result shaped only for prose - rows packed into
strings, figures nested inside objects - cannot.

### Read-only database queries

`database_schema` lists what `database_query` may read, and `database_query` runs one SQLite
`SELECT` against OMC's own database (ADR 0036). Both are offered to the built-in Agent only
(`Adapters: ["agent"]`); MCP clients do not see them. The policy lives in
`internal/repository/readonly_query.go`, not in the capability:

- a separate read-only connection (`mode=ro`, `query_only`, no attached databases, bounded value
  sizes);
- exactly one `SELECT` or `WITH` statement;
- the compiled program is read before it runs: every table or index opened must belong to a table
  in `QUERY_READABLE_TABLES`, no column in that table's redacted list may be read, no index
  covering a redacted column may be opened, and writes to stored tables, virtual tables (so
  `json_each` and `pragma_*`) and databases other than `main` are refused; SQLite's scratch
  b-trees (`ORDER BY ... LIMIT`, `UNION`, `DISTINCT`, recursive CTEs) stay usable;
- at most 200 rows, 24 KiB, 500 characters per cell and 5 seconds; credential-shaped text, URL
  userinfo and email addresses are masked in cells and error messages. Masking is best-effort (a
  value transformed in SQL passes unmasked), so a secret-bearing column is redacted, not left to
  the mask.

A refusal or an SQL error is an `error` result whose `detail` names what to change. Every table
must be classified: readable in `QUERY_READABLE_TABLES` or hidden in `QUERY_HIDDEN_TABLES` with a
reason, and `TestEveryTableIsClassifiedForOperatorQueries` fails until a new table is. A migration
that adds a column able to carry a secret to a readable table adds it to that table's redacted list
in the same change.

The console draws a query as a normal capability-call row, without a raw-result preview. Agent
session reads, final snapshots and streamed query receipts omit raw query data; the session DTO
also omits the private model history and queued model calls. This applies to restored sessions as
well as new runs. Query status, diagnostics, SQL arguments and timing remain inspectable. The
full result stays in the server-side conversation for subsequent model rounds and explicit
`render_chart` / `render_table` calls. This is a browser-preview boundary, not an upstream-data
restriction: the selected model still receives query rows and may quote them in its answer or
choose them for a final display.

### Secrets and OAuth

- Secrets never enter tool arguments. A capability that needs one declares
  `HumanInput: "secret"`: the agent prepares the non-secret parameters, and the
  console's private form posts the value directly to the server while the operation is
  approved.
- OAuth flows use `HumanInput: "oauth"`. The capability server starts the flow, keeps
  the authorization URL, state, and device code on the server, and exposes them only to
  the signed-in browser. The model sees the operation id and its status.
- Tool results must not contain credentials, tokens, raw upstream error bodies, email
  addresses, or file paths. Reuse `safety` projections from `internal/operations`
  rather than inventing a new shape.

## What is not exposed

Capabilities are opt-in. The following are deliberately not reachable by an agent, and
a new capability must not add them:

- provider runtime-policy and advanced model edits through the console's whole-entry
  provider-edit facade, which also handles credential material. A dedicated
  secret-free shared operation is required before those edits become Agent tools;
- raw credential reads, auth-file downloads, or key reveals; Vertex service-account
  import remains a console-only file handoff, not raw key material supplied through
  model-visible capability arguments or previews;
- arbitrary URL, CPA, or HTTP proxying; SQL beyond the read-only query surface above
  (no writes, no hidden table, no redacted column); filesystem; shell; or host maintenance;
- plugin installation, execution, or configuration, including the plugin system settings;
- raw configuration YAML writes - only the named scalar allowlist
  (`request_retry`, `max_retry_interval`, `max_retry_credentials`,
  `routing_strategy`, `force_model_prefix`), each written as a one-path change set on the
  v8 configuration API. Like any configuration save, each one keeps a backup of the
  stored file first, and the first one to a pre-v8 file makes CPA convert it (ADR 0051);
- configuration backup restore, deletion and retention: a restore is a whole-document
  write, and the other two discard the copies a restore depends on (ADR 0051);
- the credential fields that can transport secrets: `oauth_set_credential_fields`
  accepts `prefix`, `priority`, `weight`, `note`, `excluded_models`, `expired`,
  `disable_cooling`, `websockets`, `using_api`, `request_retry`,
  `request_scoped_errors` and `model_aliases`, while `headers` and `proxy_url`
  stay console-only because either can carry credential material into a preview;
- approval, secret submission, or OAuth completion for an operation an external agent
  prepared.

A capability that cannot be implemented safely must be omitted here and recorded in
the pull request with the reason, rather than added with a weaker check.

## Adding an agent-capable feature

When a new OMC feature suits an agent:

1. Put the business operation in `internal/operations` (or extract the existing
   handler body into it) so the console and the registry share one implementation -
   including the write gate, revision checks, and readback verification.
2. Register the capability with its permission, risk, adapters, `Invalidates`, and
   confirmation preview. Do not add per-feature code to `internal/agent` or
   `internal/mcpbridge`.
3. Add tests for the declaration (schema and permission), the permission or confirmation
   path, and the operation itself, including a failure path.
4. Give the console's capability directory its copy: `agent.capability.<name>` (a short title)
   and `agent.capability.<name>.description` (what the call does, for the operator) in
   `web/src/i18n/index.tsx` and every catalog under `web/src/i18n/locales/`. The registry's
   `Description` stays English and is written for the model; the console shows it only in an
   expanded row. `scripts/capability-copy.test.mjs` fails when a registered capability has no copy
   or copy names a capability that is gone, reading the registry from the regenerated demonstration
   dataset.
5. If the capability is intentionally not exposed, say so in the pull request.

## External agents (MCP)

```bash
OMCPA_SERVER_URL=https://omc.example.com/omc \
OMCPA_CPA_MANAGEMENT_KEY=<your CPA management key> \
oh-my-cpa mcp
```

The subcommand runs before configuration, database, and CPA client initialization, so
the bridge process opens no data directory and holds no CPA credential of its own. It
authenticates to the capability endpoints with the management key as a bearer token;
non-loopback URLs must be HTTPS, redirects are refused, and responses are bounded.

MCP clients see every capability declared with the `mcp` adapter. `ask_question` (an MCP
client has its own way to ask its user) and the read-only database queries are offered to
the built-in Agent only.

Because the management key is administrator-equivalent, an external process holding it
can also log in to the console. Use MCP only with agents and hosts you would trust with
the console itself, and rotate the key if that trust changes.

### Pricing provider membership

`pricing_list` includes `providers` for the models in its bounded current page. Each membership carries the configured provider id, family, snapshot name, channel, priority, OAuth marker, a hostname-only endpoint hint and exact model identities. This read uses the stored complete CPA catalog and never retrieves credential secrets. Provider-specific presentation does not create separate prices: `pricing_set` still edits the global model identity, with its existing revision and confirmation policy.

`pricing_list` also returns `candidates`, keyed by model, for the custom and linked prices on its page that OpenRouter now offers a price for and the operator has not answered: `kind` `automatic` (auto mode would match it) or `suggested` (a resemblance), with the OpenRouter model and its rates; a failed lookup leaves it empty rather than failing the list. An agent acts on one through `pricing_set` (mode `auto`, or `linked` to the candidate's id), which records the answer like a console save; ignoring a candidate is left to the console, because it only silences a prompt and changes no price.

### Pricing an agent can carry out end to end

Five reads surround the pricing writes so an agent can work a price out, check it and
only then ask for approval. All are low-risk reads on both adapters, bounded to 20 rows
a page, and none returns a secret.

- `pricing_overview` (`offset`): `sync` (`is_known`, `is_running`, `has_failed`, last
  success, next run, interval, `upstream_models`), `coverage` counts by mode, and the
  `unpriced` models busiest first with 30-day traffic and up to two OpenRouter
  suggestions. The stored sync failure text is withheld because it can quote an
  upstream response; `has_failed` says that it exists.
- `pricing_get` (`model`): `price` (absent when unpriced), `automatic` (what auto mode
  would match), `suggestions`, `candidate`, `channels` serving the model, `usage_30d`
  and `profile_7d` (median request size and the largest prompt). Advisory fields are
  left out when their lookup fails.
- `pricing_catalog_search` (`query`, `offset`): the stored OpenRouter snapshot matched
  on id, name and canonical slug, exact ids first, with rates and tiers.
- `pricing_quote`: one hypothetical request (`input_tokens`, optional output and cache
  tokens, `timestamp_ms`, `channel`) priced against `model`'s stored price or a
  `proposed` object shaped like `pricing_set`'s input. It returns the resolved `price`,
  the `breakdown` with the governing `tier_index`, and `cost_usd`. Nothing is written.
- `requests_cost_breakdown` (`id`): a recorded request's pricing status, stored nanos,
  locked price and channel versions, tier and per-bucket rates; `resource_missing` for
  an unknown id.

A time-of-day tier's `utc_start`/`utc_end` are HHMM on the clock named by `time_zone`,
UTC when omitted (ADR 0063). An agent given a vendor's price page enters the published
hours with the vendor's zone; converting them to UTC is wrong for any zone with
daylight saving and is never needed. `pricing_set` resolves a link or an automatic
match while preparing, so a model outside the CPA catalog, an unknown OpenRouter id
or an automatic switch with no match arrives as `invalid_parameters` with a detail
rather than as a failed approval. Tests in
`internal/operations/pricing_test.go` cover both adapters, the refusals, the dry run
and the breakdown's schema.

### Usage and request filters

`usage_aggregate`, `usage_compare` and `requests_list` share one input, so a question
narrowed for a list is narrowed the same way for a total. Beyond the exact dimensions
(`providers`, `models`, `call_points`, `client_keys`, `credentials`, `status`) it takes
`search` (a literal substring, at most 256 characters), `min_latency_ms`, and a pattern:
`regex_field` (one of `model`, `model_alias`, `response_model`, `provider`, `endpoint`,
`ua`, `request_id`) with `regex`, an RE2 pattern of at most 256 characters. A pattern
without a known field, or one RE2 refuses, fails with `invalid_regex: <reason>` so the
model can correct the call; other malformed input stays `invalid_parameters`. All three
are low-risk reads with no secret or OAuth handoff.

A request item carries `request_id`, `ttft_ms`, `user_agent` (the product label already
redacted at ingestion) and, only when the upstream served a different model,
`served_model`, alongside provider, model, call point, tokens, latency and cost. Raw
logs, client addresses, key masks and credential names stay out. The field descriptions
are kept short on purpose: the input is repeated in three tools and the catalogue has a
size budget (`TestAgentCatalogueFitsTheSchemaBudget`). Tests cover the filter mapping and
each refusal (`internal/operations/validation_test.go`), the matching itself
(`internal/repository/usage_filter_test.go`) and the HTTP parameter
(`internal/api/usage_events_test.go`).

### Timezone capabilities

`timezone_get` is a low-risk read returning the optional manual override, deployment timezone and effective IANA timezone. `timezone_set` is a low-risk write accepting `{ "timezone": "Asia/Kuala_Lumpur" }`; an empty string restores the deployment timezone. Both are available to Agent and MCP administrators under the existing capability policy. The write shares the preference repository's validation and commit-before-publication rule, returns `invalid_timezone` for an invalid name, and invalidates `preferences` and `timezone` readers. No secret or OAuth handoff is involved. Tests cover validated writes, reads through both adapters and refusal without changing the runtime calendar.

### TPS calculation capabilities

`tps_calculation_get` is a low-risk read returning `{ "mode": "exclude_ttft" }` or
`{ "mode": "include_ttft" }`. Missing or unsupported stored preferences resolve to
`exclude_ttft`. `tps_calculation_set` is a low-risk write accepting the same mode
shape, rejects unsupported or absent mode values with `invalid_parameters`, and
returns the saved mode. Both are available to Agent and MCP administrators under
the existing policy. The write shares the console's `omc_tps_calculation_mode`
preference and invalidates `preferences`; no secret or OAuth handoff is involved.
It changes request-record and Playground TPS readouts, not original timings or usage.
Exclusion subtracts measurable first-token latency and otherwise uses total latency;
inclusion always uses total latency. Tests cover both adapters, shared preference
reads/writes, defaults, invalid values and administrator refusal.

### Browser connection recovery

Managed Agent execution belongs to the server, not a socket. Console refresh or network recovery
replays its projected journal and does not invoke capabilities again. Stop calls the authenticated
run cancellation endpoint; a disconnected subscriber does not signal operator intent. Pending
approvals, secrets and OAuth continue through their existing server-side handoffs and are never
automatically decided during recovery. Process restart does not resume uncertain external writes.
See [ADR 0044](adr/0044-browser-connections-subscribe-to-server-owned-runs.md).

### Custom icon library

`custom_icons_list` is a low-risk read for Agent/MCP, accepting an optional `offset` and returning at most twenty icon metadata records plus `has_more`. It includes names, stable IDs, revisions and stored reference counts, never image bytes. `custom_icon_create` accepts `{name,data}` and `custom_icon_update` accepts `{id,name?,data?}` as low-risk presentation writes. Both reuse the browser import validation and return metadata only. The existing 32 KiB capability input cap still applies; larger artwork must be imported through the browser picker rather than widening the tool envelope.

`custom_icon_delete` accepts `{id}` and is destructive/high-risk on both adapters. Its preview contains the icon ID/name, artwork revision, reference count and `provider_icons: restore_defaults` impact; approval rechecks the artwork revision, removes all current matching overrides and deletes the asset in one transaction. Every successful write invalidates `custom-icons`; deletion additionally invalidates `preferences`. Stable refusals are `custom_icon_invalid_image`, `custom_icon_too_large`, `custom_icon_invalid_name`, `custom_icon_limit`, `custom_icon_not_found`; stale deletion approval returns `resource_conflict`. No artwork is returned in capability output, preview or audit details. Tests exercise both adapters, administrator permissions, refusal, reference-reset confirmation and confirmed deletion.


## Quota capacity output

`quota_list` and `quota_refresh` expose the same safe window results as the console.
Their `plan` projection contains only `plan_type`, `plan_label`, `tier` and optional
`subscription_active`; false denotes an explicit inactive subscription, while an
absent field means unknown. The projection includes live xAI/Antigravity tiers and
Meta plan readings, not credential metadata, raw responses or minted keys. Meta
refresh uses its key-exchange endpoint and can mint a key upstream; the refresh
tool description states this side effect, and returned keys are discarded (ADR 0065).
No new capability or permission is needed: listing remains a read and refreshing
remains a low-risk write. Their tool descriptions identify these as estimates rather
than balances or routing instructions.

Each supported window can carry `usage` (current cycle's half-open range, requests,
priced requests, tokens and locked cost), `capacity` (tokens, optional locked-cost
estimate and rounding allowance), and `capacity_unavailable` (why the current cycle
cannot be estimated). A capacity's `basis` is `current_cycle` or `previous_cycle`, and
`observed_at_ms`, `from_ms` and `reset_at_ms` identify the reading it derives from.
A previous-cycle reference must be described as historical, never as the current
remaining balance; its current unavailable reason and current recorded usage remain
in the result. Neither value is an actual provider-denominated quota or a spend forecast.

`model_families` identifies reviewed scope metadata. `has_mid_cycle_reset` is durable
reset evidence; `has_incomplete_history` preserves a failed evidence read for the cycle.
Neither flag is an estimate. Unknown scope/alias resolution, unavailable
history and unavailable usage return `scope_unknown`, `history_unavailable` and
`usage_unavailable`; these never mean zero. Only a fresh valid current cycle with
`low_usage`, `no_traffic` or `no_reading` may carry a previous-cycle reference. Missing
history, changed scopes/periods and early-reset cycles do not produce one. Costs use
request-time prices and require 95% priced-request coverage; error percentages describe
rounding only and must not be presented as statistical confidence. See ADR 0059.

### Available model directory

`models_list` is a low-risk read exposed to the Agent and MCP. It takes no parameters,
requires the existing read permission and performs no inference or mutation. Its safe
`models`, `providers`, `routes`, `partial`, `model_info` and `metadata_updated_at` result
is shared with `GET /management/model-square`. CPA's live `/v1/models` is authoritative;
the first nonempty configured client key is used server-side and never disclosed.
Without one, the operation returns `client_key_required`.

Exact call points may retain several upstream targets. Empty `upstream_model` or
`provider_id` denotes unresolved provenance; unreadable enrichment does not suppress
advertised models. Bundled models.dev facts are matched only by exact canonical identity
or an unambiguous source alias. They do not establish operational availability or an
open-source license. Names/icons use current deployment overlays; endpoints are reduced
to hostnames. Secrets and account fields are excluded. Results exceeding 2,000 routes
are refused with `tool_result_too_large`.

### OAuth credential refresh

`oauth_refresh_credential` is a high-risk write accepting `name` and `auth_index`. It
asks CPA to renew that credential's tokens now instead of at its scheduled refresh and
returns only whether it succeeded: CPA's own answer carries the renewed tokens, so it
is discarded inside the management client and never reaches a preview, a result or the
audit log. It invalidates `management-auth-files` and `management-quota`.

### OAuth model exclusions

`oauth_excluded_models_list` reads the provider-wide, normalized exclusion map and
its revision. `oauth_set_excluded_models` is a high-risk write accepting `provider`
and `models`. Its preview names the provider and shows before/after rules; execution
requires the operator's confirmation and rechecks the map revision under the shared
whole-config write gate. It reuses the console facade's rule validation and verified
CPA readback, then invalidates the exclusion map, credential model lists, Model Square and pricing.
An empty list removes only that provider's rules. The wildcard `*` hides every model
for that provider's OAuth credentials, so it must remain visible in the preview.
These capabilities are available through the built-in Agent and stdio MCP registry,
without a new adapter or any secret-bearing response.

### Plugin-page native boundary

The browser's trusted Plugin Host (ADR 0067) is not an Agent/MCP capability. It exposes native
secret-bearing configuration only through an authenticated console session; models and
external agents continue to use the declared sanitized capability registry and its
confirmation/revision rules. No arbitrary native path or URL becomes a tool argument.
