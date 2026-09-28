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
  and resumption. It never touches the database, configuration, or the CPA client
  directly.
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

A declaration is one call to `capability.Register` with:

| Field | Meaning |
| --- | --- |
| `Name` | Stable `snake_case` adapter-facing tool name; duplicates fail startup |
| `Description` | What the tool does and what it does not reveal; shown to the model |
| `Version` | Incremented when a pending operation's meaning changes |
| `Permission` | `read`, `write`, or `destructive` |
| `Risk` | `low` or `high`; `high` requires a prepare function and human confirmation |
| `HumanInput` | Optional `secret` or `oauth` browser handoff |
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
   `Target`, `Revision` (the identity and version the approval is bound to),
   `Changes`, and - for destructive actions - a `Challenge` the operator must type.
3. The executor stores the pending operation encrypted, writes a `prepared` audit
   event, and returns `{status: "pending", operation_id: ...}` to the caller.
4. A signed-in operator approves or rejects it in the console. Approval re-validates
   the capability version, the caller's authority, and the resource revision inside the
   same write gate that performs the change.
5. The result is recorded (`success`, `partial`, `error`, or `uncertain`) and audited.
   An operation is consumed once; a repeated approval returns the stored outcome.

Rules that are not optional:

- Destructive capabilities must ask the operator to type the target identifier. A
  batch operation must show the resolved target list and its count, and must never
  expand a wildcard at execution time.
- The approval is bound to the revision captured by `Prepare`; if the target changed,
  the executor returns `resource_conflict` and the operator must re-confirm.
- A write that may have reached CPA but cannot be verified is reported as `uncertain`
  (`operation_outcome_unknown`), never as a plain error and never retried
  automatically.
- A write whose result fails output validation is also `uncertain`, because the change
  may already have been applied.

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
- arbitrary URL, CPA, or HTTP proxying; SQL; filesystem; shell; or host maintenance;
- plugin installation, execution, or configuration, including the plugin system settings;
- raw configuration YAML writes - only the named scalar allowlist
  (`request_retry`, `max_retry_interval`, `max_retry_credentials`,
  `routing_strategy`, `force_model_prefix`);
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
4. If the capability is intentionally not exposed, say so in the pull request.

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

Because the management key is administrator-equivalent, an external process holding it
can also log in to the console. Use MCP only with agents and hosts you would trust with
the console itself, and rotate the key if that trust changes.
