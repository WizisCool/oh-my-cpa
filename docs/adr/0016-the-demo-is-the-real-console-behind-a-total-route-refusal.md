# ADR 0016: The public demo is the ordinary binary with its gateway replaced, and its boundary is a route classification

- Status: Accepted; superseded in part by [ADR 0021](0021-the-public-demonstration-is-generated-data-behind-the-real-console.md)
- Date: 2026-09-20

> **What still holds.** The demo mode described here is live: `internal/demo` and the
> route classification are what generate the public demonstration's dataset, and they
> are how the self-hosted paths are tested without a gateway.
>
> **What changed.** The public hosting and the execution model. ADR 0021 moved the
> demonstration to a Cloudflare Worker serving generated data, so the public page no
> longer runs this binary and no longer simulates a visitor's writes. The decision above
> is unchanged as the account of the fixture; `docs/ops/cloudflare-demo.md` is the
> current runbook.

## Context

Oh My CPA needs a demonstration that can be linked from the README: reachable by
anyone, showing the real console rather than screenshots, requiring no CPA
management key, no provider key and no OAuth credential, and deploying itself from
`master`. The pressure this creates is toward a second artefact - a mocked frontend,
a demo branch, a separate fixture service - and the cost of that is a console that
diverges from the one operators run, silently, until somebody notices.

Three decisions had to be made.

**Where the gateway data comes from.** The console reads CPA through
`internal/cpa/management` in about twenty handlers, each with its own DTO allowlist.
Options: an adapter implementing a management-client interface; a fixture HTTP service
as a second process; or a fixture HTTP service in-process.

**How the dangerous surface is closed.** The console has routes that start a real
sign-in, move credential material, execute plugins, write the gateway configuration,
spend a quota entitlement and hand back raw request and error logs. Options: hide the
controls; refuse at each handler; or refuse at the route table.

**How anyone gets in.** Options: a published demo password; a session minted for
whoever opens the page; or no session at all on the API.

## Decision

### 1. Demo mode is a configuration of the ordinary process

`OMCPA_DEMO_MODE=true` is read by `internal/config`, is off by default, and changes
only what it must: the data directory, the database filename, the master key when
none is supplied, the base path default, the listening address when the platform
announces one, and the public origin. `internal/app` starts the fixture and points
the existing configuration at it. Nothing is compiled out, and no page, handler or
DTO has a demo variant.

### 2. The gateway is replaced at the socket, not at the interface

`internal/demo` serves the CPA management API on `127.0.0.1` and the application is
pointed at it through the ordinary configuration path, so every existing read - the
credential projection, the provider lists, the configuration document, the model
catalogue, the plugin lists, the log tail - runs unmodified.

The cost is an in-process HTTP hop and a fixture that has to answer the endpoints the
console actually reads. The alternative was rejected because the interface spans
about forty methods: an adapter would have had to reproduce every response shape from
Go structs, and the seam would have to be threaded through every handler that builds
a client, which is where a demo branch would start leaking into the product.

The fixture never dials the URL it is handed. It resolves the requested provider
endpoint against its own catalogue and refuses anything else, so "the demonstration
performs no outbound request" is a property of the code. It publishes no plugin logo
URL, and the plugin-logo inliner is not installed in demo mode, for the same reason.
The pricing sync loop and the capture pipeline are not started, because both would
reach outside the process.

### 3. The boundary is a total route classification, and an unclassified route is refused

`internal/api/demo_policy.go` holds one table of `method + chi route pattern +
verdict`, first match wins, ordered from the specific to the general. The test suite
walks the router the server actually serves and fails if any registered route has no
verdict, so adding an endpoint forces a decision instead of inheriting one. At
runtime an unclassified path is refused.

Refusals answer `403` with a marker header and a message naming the reason. Reads are
marked as belonging to a demo, and a write carries a header saying its result is not
durable.

Two consequences are deliberate:

- **The table's order is load-bearing.** The trailing wildcard that serves the SPA is
  last. While it was first, it classified every `GET` in the application as public,
  and the credential download and the request log were both allowed. The test that
  exercises the refusals over HTTP found it.
- **Hiding a control is never the boundary.** The console still disables the buttons,
  because a control that cannot work should not offer to, but every one of those
  routes is refused by the server, which is what the suite asserts on.

### 4. A session is issued to whoever asks, including on an ordinary API read

The demonstration has no secret to protect, so the session is not a credential
boundary - the route classification is. It exists so the console's ordinary
navigation works.

It is issued on any unauthenticated request rather than only on the sign-in endpoint
because the platform runs several container instances behind one address, each with
its own fixture key: a cookie minted by one instance is invalid at the next, and the
console issues its first queries in parallel with the session check. Refusing those
reads produced the observed failure - a working page falling back to a sign-in card
about a second after it rendered. Issuing the session instead makes every request
succeed and every instance self-sufficient.

## Consequences

**Accepted:**

- The demo's data is fabricated and says so in the docs. It is not a claim about any
  particular deployment's traffic.
- The demo reports a healthy capture state it does not have, because the panel that
  reads it is the request list's own header; the numbers beside it are read from the
  database. This is a presentation choice, and it is recorded here rather than left
  to be discovered.
- Seeding writes about fourteen thousand requests and takes about four seconds on a
  cold start. The database is deleted and rebuilt on every boot, because a platform
  that scales to zero would otherwise come back with a history that ends hours ago
  and empty short windows.
- The fixture duplicates the provider quota URLs rather than importing
  `internal/quota`'s constants, so a change there cannot silently change what the
  demo answers. A test pins the two lists to each other.

**Rejected:**

- **A mocked frontend or a demo branch.** It would diverge from the console
  operators run, and the divergence would be invisible until it mattered.
- **A published demo password.** The password would be public anyway, and it would
  suggest the credential protects something.
- **Refusing at each handler.** About twenty handlers would each carry a demo branch,
  and a new handler would inherit none of them - the opposite of a total
  classification.
- **Intercepting the demo at the network boundary** (a firewall rule, a proxy that
  refuses egress). It would make the property environmental, so it could be false in
  a deployment that forgot the rule while looking identical in the repository.

**Cost to the self-hosted path:** none beyond the configuration switch. Demo mode is
not set, the fixture is never started, the policy middleware is not installed, and
the database filename is the one it always was. `internal/api`'s test suite asserts
that a self-hosted router answers an unclassified path with the ordinary API rather
than a demo refusal.

## References

- `docs/architecture.md` §12 — the demo's shape, seeding and platform adaptation
- `docs/ops/vercel-demo.md` — the deployment runbook and the console steps
- `internal/api/demo_policy.go`, `internal/demo/` — the implementation
- ADR 0001 — the process shape the demo reuses rather than replaces
- ADR 0015 — the credential rule the demo's refusals extend to a public deployment
