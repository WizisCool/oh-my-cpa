# ADR 0021: The public demonstration is generated data behind the real console

- Status: Accepted
- Date: 2026-09-22
- Supersedes: the hosting and execution aspect of [ADR 0016](0016-the-demo-is-the-real-console-behind-a-total-route-refusal.md)

## Context

ADR 0016 decided the public demonstration would be the ordinary binary with its gateway
replaced by an in-process fixture, and that its boundary would be a total route
classification. It rejected a mocked frontend, an adapter at the handler layer and a
separate fixture process, on the grounds that each would let the demonstration diverge
from the console operators run.

That design assumed a host that could run the binary. The host it was deployed to - a
container on a platform whose Hobby tier caps a repository at 50 images and provides no
collection of its own - reached that cap, and every deployment after it built for three
minutes and then failed at its last step:

```
denied: repository has reached the maximum allowed number of images
```

The cap is not a bug to be worked around. It is a property of the platform, and no build
configuration fixes it: the images accumulated because each deployment pushes one and
nothing reclaims it. The demonstration had outgrown the hosting its design assumed.

Two things had to be decided: whether to pay for hosting that runs a container, or
whether the demonstration needed a container at all.

## Decision

### 1. The demonstration serves the real console from generated data

The console is the same bundle the Go binary embeds. Its API is answered by a Cloudflare
Worker from a dataset generated out of the real Go handlers, through the same DTO
projections a self-hosted install produces. Nothing about the frontend changes.

The dataset is produced by `internal/api/demo_export_test.go`, which starts the real
handler over a seeded repository and the demo fixture, drives every read the console
makes, and writes what comes back. It is not hand-written, and it is not a recording
taken from a browser: generating it through the handlers is what keeps every response
the shape the product actually emits.

### 2. Coverage is a gate, not an instruction

A dataset that describes the API cannot be kept current by intention, because the
failure is invisible - the page renders, showing what the API said last month.
`scripts/check-demo.mjs` fails when a console route has no declared reads, when a read
has no captured response, when a file the dataset derives from has changed, or when the
dataset carries a value that must not be public.

### 3. The captured history is re-based when it is served

The console asks for a window by name - `preset=24h`. A frozen capture describes a
window that ended when it was generated, so the newest chart would be flat within a day.
Every response is moved onto the viewer's clock by a single delta, which keeps a
window's bounds, its buckets and the rows inside it describing one span.

### 4. The Go demonstration mode stays

`internal/demo`, `internal/api/demo_policy.go` and the binary's own demo mode remain.
They are what generates the dataset, they are how the self-hosted paths are tested
without a gateway, and they are the oracle the drift gate compares against. Only the
public hosting changed.

## What this costs

**The demonstration is no longer an execution of the product.** This is the loss ADR
0016 was written to avoid, and it is real: a visitor sees the console, not the server.
No database runs, no migration applies, no capture pipeline starts, and the version and
release panels show generated content rather than a real observation of the running
service. The demonstration shows what the console looks like; it does not demonstrate
the product's behaviour.

**Read computation is duplicated.** The Worker answers windows, groupings and filters
that the Go handlers compute from SQLite. Generated response bodies cannot prevent that
logic from drifting - only the coverage gate, the differential export and the browser
check can, and they reduce the risk rather than removing it. This is the alternative
ADR 0016 rejected, now accepted knowingly.

**The demonstration is read-only.** ADR 0016 let a visitor's writes land in the fixture's
in-memory state, so a control that could not work still appeared to. The Worker has
nowhere to put a write, so it refuses them, and the console renders its existing refusal
notice. The alternative - simulating writes in a Worker isolate - would be shared mutable
state that no visitor could see the effect of, which is worse than an honest refusal.

**The dataset is public.** It is downloadable by anyone who opens the demonstration, so
it must carry nothing an operator would not publish. This is enforced by the gate rather
than by review, and it is why the caller-key aliases name roles rather than a person.

**The hosting platform injects a third-party script into the page.** Cloudflare adds its
Real User Measurement beacon to HTML on this plan, from `static.cloudflareinsights.com`,
and it appears in no repository, no build output and no code review. It was measured on
the deployed page rather than inferred: the origin returns HTML without it, and the
browser requests it anyway.

This is worth recording because it changes what "the demonstration contacts nobody" can
mean. The claim this project actually needs, and still holds, is about its own code: the
fixture resolves a provider endpoint against its own catalogue and refuses the rest, and
the Worker answers from the dataset and forwards nothing, so no provider is ever
contacted in either deployment. The beacon is a request a visitor's browser makes to the
host's own analytics endpoint, carrying no credential and no request data. It was
accepted knowingly rather than overlooked - suppressing it is possible, and was tried:
`Cache-Control: no-transform` on the documents does stop the injection, and that was
removed once the beacon was judged acceptable, because keeping a suppression the project
does not want would be a claim the repository does not mean.

## Alternatives rejected

**Pay for hosting that runs the container.** It would preserve the property ADR 0016
wanted, at the cost of a subscription for a page whose purpose is to show a console. The
owner chose the demonstration's purpose over its execution model.

**Bake the frontend with static fixtures inside the bundle.** It would remove the Worker
entirely, and with it the ability to answer a window the visitor picks; the console's
range picker would have to go or become a lie.

**Slim the demonstration to a landing page.** It would remove the divergence risk
altogether by removing the thing worth demonstrating.

## Consequences

- The demonstration deploys from `master` through Cloudflare's Git integration, which
  manages its own build token, so no repository secret is required - one of the
  grievances that made the previous platform unattractive.
- Every change to a console page's data now carries an obligation: regenerate the
  dataset, read the diff, commit it. The gate fails until that happens, which is the
  point.
- `pnpm verify:demo` drives every route in a real browser against a running
  demonstration. It caught three defects that unit tests did not, including a model
  catalogue rewritten into dates by a lenient date parser.
- The version and release panels in the public demonstration are sample content and are
  labelled as such. The self-hosted page still observes real versions, because
  `internal/release` and its tests are untouched.
