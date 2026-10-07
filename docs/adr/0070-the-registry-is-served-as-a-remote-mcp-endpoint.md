# ADR 0070: The capability registry is served as a remote MCP endpoint

- Status: Accepted
- Date: 2026-10-07
- Extends [ADR 0026](0026-one-capability-registry-over-shared-operations.md): the
  management key is now accepted as a bearer credential at one more path, the MCP
  endpoint. Everything else in ADR 0026 stands.

## Context

External agents reached Oh My CPA only through `oh-my-cpa mcp`, a stdio process that
forwards MCP tool calls to the capability HTTP endpoints. That requires the OMC binary
on the machine the agent runs on. Most deployments are a container on a server, while
the agent runs on a laptop or in a hosted environment: connecting meant downloading a
release archive for the agent's platform only to proxy HTTPS requests that the agent's
own MCP client could have made itself. Clients that only accept a URL could not connect
at all.

The capability endpoints already accept the management key from any network location,
so the question was never whether to allow remote access, only whether it needed a
local helper process.

## Decision

Oh My CPA serves the registry over MCP's Streamable HTTP transport at
`<base path>/api/mcp`, in the console process.

- **One server definition, two transports.** `mcpbridge.NewServer` declares the tools
  from a `Backend`; the endpoint's backend calls `capability.Executor` in-process and
  the stdio bridge's backend calls the capability HTTP endpoints. Tool names, schemas,
  annotations, instructions, the approval link and `omc_operation_status` cannot differ
  between them. The stdio bridge stays for clients that only speak stdio.
- **Bearer only.** The endpoint accepts `Authorization: Bearer <management key>` and
  nothing else. A console session cookie is refused, so a page open in the operator's
  browser cannot drive it. Wrong keys spend the same per-address throttle as the login
  form. The principal is the existing `mcp` one: every capability declared for that
  adapter, and never approval, secret submission or OAuth completion.
- **Stateless, plain JSON responses.** No tool needs a server-initiated message, so the
  endpoint keeps no MCP session: nothing to hold in memory, nothing lost on restart,
  and a request is complete on its own behind any reverse proxy. `omc_operation_status`
  takes `wait_seconds` (at most 30) so an agent can wait for the operator's decision in
  one call instead of holding a stream open.
- **Approval stays in the console.** A prepared operation's result carries a link to
  `<console>/authorize/<id>`, built from the address the caller reached. It opens a
  standalone authorization screen outside the console's shell, modelled on the consent
  screens of the services agents already connect to: who is asking, on which
  deployment, for which capability, the prepared change, and Deny and Allow as equal
  targets. The operation was raised in another program, so there is no transcript to
  place a card in (ADR 0043), and an operator arriving from a link came to answer one
  question. The sign-in gate runs first, and the decision goes to the same endpoint as
  the built-in Agent's approvals (ADR 0035), under the operator's session.
- **Refused in demo mode**, like capability invocation.

## Consequences and trade-offs

- The management key now travels from wherever the agent runs. This is the same
  exposure the capability endpoints and the login form already had; the console warns
  when it is being served over plain HTTP off loopback, and the stdio bridge keeps
  refusing non-loopback plain HTTP. The endpoint itself cannot refuse plain HTTP: behind
  a TLS-terminating reverse proxy every request reaches it as HTTP.
- The SDK's DNS-rebinding guard, which rejects loopback connections carrying a
  non-loopback `Host`, is disabled. It would refuse every request forwarded by a
  reverse proxy on the same host, which is a documented deployment. What it defends -
  an unauthenticated local server reachable from a hostile web page - does not apply:
  the endpoint requires a credential the page does not hold and ignores cookies. The
  SDK's cross-origin check for browser requests stays on.
- No OAuth authorization server is offered. Clients that insist on OAuth discovery
  cannot connect by URL and use the stdio bridge. A per-agent credential would be a
  second authority model beside the one ADR 0026 chose, and is a separate decision.
- `internal/api` now depends on `internal/mcpbridge` and, through it, on the MCP SDK.
- A stateless endpoint cannot push `tools/list_changed`. The registry is fixed at
  startup, so there is nothing to push.
