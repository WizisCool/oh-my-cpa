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
8 chart series and 96 KiB.

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

- raw credential reads, auth-file downloads, or key reveals;
- arbitrary URL, CPA, or HTTP proxying; SQL beyond the read-only query surface above
  (no writes, no hidden table, no redacted column); filesystem; shell; or host maintenance;
- plugin installation, execution, or configuration, including the plugin system settings;
- raw configuration YAML writes - only the named scalar allowlist
  (`request_retry`, `max_retry_interval`, `max_retry_credentials`,
  `routing_strategy`, `force_model_prefix`), each written as a one-path change set on the
  v8 configuration API. Like any configuration save, the first one to a pre-v8 file makes
  CPA convert the file, after OMC keeps a backup of it (ADR 0037);
- the credential fields that can transport secrets: `oauth_set_credential_fields`
  accepts `prefix`, `priority`, `weight`, `note`, `excluded_models`, `expired`,
  `disable_cooling`, `websockets`, and `using_api`, while `headers` and `proxy_url`
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

### Timezone capabilities

`timezone_get` is a low-risk read returning the optional manual override, deployment timezone and effective IANA timezone. `timezone_set` is a low-risk write accepting `{ "timezone": "Asia/Kuala_Lumpur" }`; an empty string restores the deployment timezone. Both are available to Agent and MCP administrators under the existing capability policy. The write shares the preference repository's validation and commit-before-publication rule, returns `invalid_timezone` for an invalid name, and invalidates `preferences` and `timezone` readers. No secret or OAuth handoff is involved. Tests cover validated writes, reads through both adapters and refusal without changing the runtime calendar.
