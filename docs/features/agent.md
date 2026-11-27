# Agent and MCP

The built-in Agent operates the console in conversation: it reads usage, explains costs,
and prepares changes that you approve. External coding agents reach the same capabilities
over MCP.

## Conversations

`/agent` sends the conversation and capability results to the CPA model selected on the
page and its upstream provider; the page states this beneath the message box, and the
choice of key, model and reasoning effort is remembered as a server-side preference.
A message may carry up to four PNG, JPEG or WebP images of at most 5 MiB each, beside up
to four text files (40 KiB together). Images are stored encrypted in `agent_documents`
for as long as their turn is part of the conversation, are sent to the model with every
round while they are among the conversation's newest eight, and are read back by the
console from `GET /api/v1/agent/images/{id}` under the console session only.

Agent runs and sessions are open-ended: OMC applies no token, round, tool-call, display-count,
run-duration or session-size ceiling. Provider context/output limits and capability payload and
security checks still apply, as do the gateway's 120-second response-header and stream-idle
timeouts and 1 MiB SSE-line limit. Completed turns send conclusions with bounded metadata to later
rounds, while the stored transcript is retained until reset or explicit replacement. A long
conversation increases SQLite and backup size, serialization work, memory and upstream request
cost. Use Stop to end active work and New conversation to release the retained transcript and
images; monitor disk and process memory on the single replica. Image admission failure attempts
to clean up only newly written image rows; database failures can prevent that best-effort cleanup.

## Connect an external agent

External agents connect over MCP to the same capability registry, in one of two ways:

| Transport | Address | Credential |
| --- | --- | --- |
| Streamable HTTP, served by the console | `<console URL>/api/mcp`, for example `https://omc.example.com/api/mcp` | `Authorization: Bearer <CPA management key>` |
| stdio, the `oh-my-cpa mcp` bridge process | `OMCPA_SERVER_URL` (the console URL, including any base path) | `OMCPA_CPA_MANAGEMENT_KEY` |

The HTTP endpoint needs nothing installed where the agent runs; the **Connect** action at
the top of `/agent` shows the deployment's address and copyable client
configuration. It accepts the management key as a bearer token only (a console session
cookie is refused), throttles wrong keys per client address like the login form, keeps
no MCP session, answers each request in plain JSON, and is refused in demo mode. A
reverse proxy needs no special rule beyond forwarding the base path; serve it over
HTTPS, because the endpoint cannot tell that TLS was terminated in front of it. Clients
that require OAuth discovery cannot use it and use the bridge instead.

The stdio bridge is for clients that only speak stdio. It accepts plain HTTP only for
loopback addresses, refuses redirects, opens no data directory, and prints its usage for
`oh-my-cpa mcp --help`.

## Approvals

There is no separate external credential: holding the management key is
administrator-equivalent, so an external agent can prepare an operation and read its
status but cannot approve it, submit secrets, or complete OAuth. A prepared change
returns `status: "pending"` with `approval_url`, a link to `<console URL>/authorize/<id>`
that the agent shows the operator. Over Streamable HTTP the link uses `OMCPA_PUBLIC_URL` when one
is set; the stdio bridge builds it from `OMCPA_SERVER_URL`, so that address must open in the
operator's browser. It opens a
standalone authorization screen where the signed-in operator (signing in first if
needed) allows or denies that one operation; `omc_operation_status` reads the
outcome and can wait up to 30 seconds for the decision (`wait_seconds`). The read-only database queries and `ask_question` are offered to the built-in
Agent only. Raw SQL results and private model history are omitted from Agent session
responses and run snapshots, and query receipts have no raw-result preview; the selected
model still receives the rows and may use them in its answer or in a projected
`data_rows` reference a drawn interface uses. How capabilities are defined is in [Agent capabilities](../agent-capabilities.md).
