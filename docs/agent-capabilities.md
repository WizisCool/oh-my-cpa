# Agent and MCP capabilities

The built-in Agent and external MCP clients use one declared capability registry and
executor. The registry is the tool catalog; this guide explains how to extend it and
which boundaries an adapter must preserve.

```text
Agent model loop ──┐
                  ├─ capability executor → shared operations → repository / CPA
MCP adapters ──────┘      validate / authorize / prepare / approve / audit
```

## Ownership

- [`internal/operations`](../internal/operations) owns business operations shared with
  console handlers: validation, revisions, write gates, backups and readback.
- [`internal/capability`](../internal/capability) owns declarations, typed schemas,
  authorization, pending operations and auditing.
- [`internal/agent`](../internal/agent) owns model rounds, persisted conversation state,
  presentation and operator questions. It invokes capabilities for managed
  resource changes, rather than creating a second management implementation.
- [`internal/mcpbridge`](../internal/mcpbridge) adapts the same registry to Streamable
  HTTP and stdio. It does not invent business logic or an alternative approval policy.

## Adding an operation

1. Reuse or extract the operation in `internal/operations`.
2. Register its typed input/output, stable name, permission, risk, supported adapters,
   cache invalidations and any confirmation preview. Keep descriptions concise: the
   eligible tool catalog is declared to the model on every round.
3. A high-risk operation prepares a preview; human input uses the declared private
   handoff. Increment the declaration version when pending-operation meaning changes.
4. Return bounded, secret-free data with display labels alongside identifiers. Put
   reusable structured rows in results rather than packing measurements into prose.
5. Add the capability title and description to the four locale catalogs. Test the
   new risk or behavior in its owning layer, following [Testing](testing.md).

A prepared operation binds canonical arguments, principal, adapter, version and the
revision used for its preview. Approval must not become permission to execute arbitrary
replacement arguments. Expired, changed or already-claimed operations cannot be reused.
The executor authorizes again and audits execution; failure to record admission stops it.

Secrets use `HumanInput: "secret"`: the model prepares non-secret parameters and a
signed-in operator submits the secret directly to the server. OAuth URLs, state and
device codes likewise stay with the server/browser flow, not the model. An external
agent can prepare an operation and inspect its status, but cannot approve it, submit
secret input or complete its OAuth flow for the operator.

## Boundary of authority

Opting a handler into Agent/MCP is a deliberate change. Do not expose raw credential
reads, auth-file downloads, arbitrary outbound HTTP/CPA calls, filesystem or shell
access, host maintenance or container updates. Plugin installation/configuration and
whole-document YAML writes stay outside capabilities. Configuration scalar edits and
credential-field edits use their existing explicit allowlists; a new field that can
carry a credential needs a private handoff, not a model-visible argument or preview.

Do not put raw upstream error bodies, tokens, email addresses or secret-bearing paths
into results. Reuse the shared safety projections. The trusted plugin-page contract is
not the Agent contract. Browser run/session DTOs omit private model history and raw
query results, even though the chosen model can receive approved business data and
quote it in an answer. The product discloses that data transfer; rendering it is not
proof that the data stayed local.

## Read-only SQL

The built-in Agent alone can use `database_schema` and `database_query`. The policy is
[`readonly_query.go`](../internal/repository/readonly_query.go): a separate read-only
connection, one SELECT/WITH statement, compiled-program inspection, classified tables,
redacted columns and bounded rows, bytes, cells and execution time.

A new table must be classified; a new sensitive column in a readable table must be
redacted in the same change. Do not rely on output masking to protect columns: SQL
could transform a secret before a string mask sees it. Writes, attached databases,
virtual tables and reads through indexes covering redacted columns are refused.
Raw query results remain in server-side model history, not ordinary browser previews.
Display programs use projected data references instead.

## Conversations and presentation

AG-UI streams server-owned runs to the browser. Disconnection ends a subscription,
not the run; reconnect reads its journal. Stop explicitly cancels execution. Prepared
operations and conversation state have different lifetimes; a restarted process cannot
continue an execution merely because a stored row says it was running.

OpenUI presentation is separate from managed-resource authority. The installed
renderer's generated language definitions live in `internal/agent/openui`; a capability
should not add a parallel UI language. Display calls render data, while forms and
operator questions use their declared waiting/answer path. Reference-backed results
avoid copying large tables into every model round. Keep the full approved result on
the server and pass bounded projections where needed.

## Connecting external clients

Streamable HTTP is served at `<console URL>/api/mcp`, including the deployment's base
path. It accepts the CPA management key as a bearer credential, not a browser session
cookie, and is disabled in demo mode. Use the Agent page's **Connect** drawer for the
actual deployment URL and current client configuration; keep the key in the client's
private configuration, not a checked-in example.

For stdio clients, run `oh-my-cpa mcp` with `OMCPA_SERVER_URL` and
`OMCPA_CPA_MANAGEMENT_KEY` in its private environment. This bridge opens no OMC database.
Non-loopback targets require HTTPS; redirects are refused. Both transports expose the
same authorized registry and human-approval behavior. Operator configuration and
recovery are in [Operations](operations.md#agent-and-mcp).
