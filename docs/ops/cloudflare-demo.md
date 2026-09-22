# The public demonstration (Cloudflare Workers)

The demonstration at the top of the README is the ordinary console served as static
assets, with its API answered by a Worker from a dataset generated out of the real Go
handlers. It is not a second frontend: the bundle is the one the Go binary embeds, and
what differs is where its answers come from.

It exists to show the console. It does not run the product - there is no gateway, no
database, no capture pipeline and no authentication behind it - and
[ADR 0021](../adr/0021-the-public-demonstration-is-generated-data-behind-the-real-console.md)
records why that trade was taken and what it costs.

## What is deployed

| Piece | Where | What it is |
| --- | --- | --- |
| Console | Cloudflare Static Assets, from `tmp/cloudflare-demo/assets` | The built SPA, with the demonstration's runtime configuration injected and its asset URLs made root-relative |
| API | `deploy/cloudflare/worker.mjs` | Reads the dataset, re-bases its timestamps and answers; refuses everything that would leave the demonstration |
| Data | `deploy/cloudflare/data/responses.json` | 79 captured responses, generated from the real handlers |
| Routing | `deploy/cloudflare/routes.mjs` | Which request is answered by which captured response |
| Time | `deploy/cloudflare/time.mjs` | Moves the captured history onto the viewer's clock |

Requests to a static asset never invoke the Worker; requests under `/api` always do.
`wrangler.jsonc` configures both, and `run_worker_first` names `/api` explicitly rather
than relying on a pattern that could also match a console route.

## The dataset is generated, never hand-written

```
pnpm demo:generate          # regenerate, then review the diff
pnpm demo:generate --check  # fail when the committed copy is stale
pnpm check:demo             # coverage, freshness and privacy
```

`internal/api/demo_export_test.go` starts the real handler over a seeded repository and
the demo fixture, drives every read the console makes, and writes what comes back. The
value of generating rather than authoring is that every response has been through the
same DTO projection a self-hosted install produces, so the demonstration cannot show a
shape the product never emits.

The export is reproducible: two runs over unchanged code are byte-identical. That is
what makes `--check` meaningful, and it needed three things to be true rather than
approximately true.

- **The window is closed, on a fixed instant in the past.** A `preset` resolves against
  the wall clock, so two exports a minute apart disagree; and the server clamps a
  requested end to the clock, so an instant in the future is not fixed either.
- **Only the instants the handler stamps while answering are moved.** The seeded history
  is anchored at the reference and is already deterministic. An earlier version displaced
  everything by a run-dependent delta, which made two exports of identical history differ
  by exactly a minute.
- **Values measured from the process are stated as constants.** Latency, heap,
  goroutines, the fixture's ephemeral port and an error-log file name stamped when the
  listing was asked for describe the machine, not the demonstration. A public page should
  not present them as though they described the service a visitor is looking at.

## Why it does not go stale

The console asks for a window by name - `preset=24h` - and the captured answer describes
a window that ended when the dataset was generated. Served unchanged, the newest chart
would be flat within a day. Every response is therefore re-based onto the viewer's clock
as it is served, by one delta per response, so a window's bounds, its buckets, its tail's
`as_of_ms` and the event rows inside it keep describing a single span.

Instants are recognised by field name - `*_at_ms`, the convention this repository already
uses - and text instants only when the whole string is an RFC 3339 instant. That second
rule is not pedantry: `Date.parse` reads `claude-haiku-4-5` as the 4th of May and `gpt-5`
as a date in 2001, so a lenient parser rewrote the model catalogue into models named after
dates.

## Keeping it current is a gate, not a habit

The dataset describes the API, so a changed response shape leaves the served copy behind
in a way nobody notices: the page renders, showing what the API said last month.

`pnpm check:demo` fails when any of these is true, and `pnpm test:self` runs it:

- a console route has no declared reads, so a new page cannot be added without a dataset
  entry;
- a declared read has no captured response;
- a file the dataset is derived from has changed since it was generated;
- the dataset contains an operator identifier, a credential shape or a deployment
  hostname. The dataset is downloadable by anyone, so this is a leak rather than a defect.

`scripts/check-demo.test.mjs` covers the gate itself, because a check that cannot fail is
worse than no check.

**When you change a console page or its API shape:** regenerate with
`pnpm demo:generate`, read the diff - it is where a changed shape shows up - and commit
the data with the change. `pnpm verify:demo` then drives every route in a real browser.

## Verification

```
pnpm test:demo              # the Worker's routing, re-basing and privacy, in Node
pnpm check:demo             # the dataset is current and complete
pnpm verify:demo            # every console route renders, no API errors, no console errors
OMCPA_DEMO_URL=https://<host> pnpm verify:demo   # the same against a deployment
pnpm verify:demo:go         # the Go binary's own demonstration mode, still supported
```

`verify:demo` is deliberately a browser check rather than a set of unit tests. Three
defects in this Worker were invisible to unit tests and obvious in one browser run: the
session endpoint sitting outside `/api/v1`, which put every page on the sign-in card; the
model-name corruption above; and an event list captured without a window, which rendered
as "no request records". It counts DOM nodes as well, and its numbers land within one or
two of the real Go binary - the dashboard at 1513 against 1514 - which is the closest
thing to a measure of "this is the same console" that a test can make.

## Deploying

The demonstration is served at **`omc-demo.junze.dev`**, as a Cloudflare custom domain.
The `workers.dev` route is off in `wrangler.jsonc`, on purpose: that subdomain is
account-level and derived from the account's identity, so leaving it on would publish the
demonstration at an address carrying personal information. Both settings are stated in the
config rather than configured once in the console, which means a deploy from a fresh clone
reproduces the deployed state instead of quietly re-enabling the address that was turned
off deliberately.

The demonstration deploys from `master` through Cloudflare's Git integration (Workers
Builds), which builds and deploys on push. **No repository secret is needed**: Cloudflare
generates and manages the build's API token, which is what made this preferable to a
GitHub Actions deployment holding a long-lived credential.

One-time setup, in the Cloudflare console:

1. Install the Cloudflare GitHub integration and grant it access to this repository only.
2. Create the Worker `oh-my-cpa-demo`, connect it to this repository, and set the
   production branch to `master`.
3. **Disable non-production branch builds**, so a pull request deploys nothing. The
   demonstration follows `master` and has no preview deployments by design. Leave the
   non-production deploy command empty and turn preview URLs off as well: a preview URL is
   built as `<version-prefix>-<worker-name>.<account-subdomain>.workers.dev`, so enabling
   them would publish the demonstration under the account-level subdomain that
   `workers_dev: false` exists to keep it off.
4. Set the build command to `pnpm build && pnpm check:demo && pnpm build:demo`, and the deploy
   command to `pnpm exec wrangler deploy --config deploy/cloudflare/wrangler.jsonc`.

   `pnpm build` is the part that is easy to leave out and cannot be: the built console's
   `assets/` directory is gitignored, so a fresh clone has `internal/web/dist/index.html`
   and nothing it references. `build:demo` stages what `pnpm build` produced rather than
   building it, so without the first command the deployment serves a blank page whose
   scripts 404. Verified in a fresh clone: `pnpm build` takes about 37s there.

   `pnpm install` is not part of it because Workers Builds installs dependencies itself,
   using the `packageManager` field and `.nvmrc` this repository already pins. No build
   variables are needed for the same reason.

The build runs on Node only. The dataset is committed, so Cloudflare never needs Go, a
browser or a database; generation and browser verification happen in development and in
GitHub's checks.

Verified with `pnpm exec wrangler deploy --config deploy/cloudflare/wrangler.jsonc --dry-run`:
597 asset files, 444 KiB total and 50 KiB gzipped. That is well inside the Workers free
plan, whose bundle limit is 64 MiB uncompressed, and it is why the dataset being
committed costs nothing to serve.

**Rollback:** Cloudflare keeps previous versions, and rolling back restores the Worker and
its assets together. The corresponding source change should be reverted on `master` too,
or the next push will deploy it again. There is no database to roll back, because there
is none.

## What the demonstration refuses

Everything that would leave it: sign-in flows, credential movement, plugin execution,
gateway configuration writes and quota spending. `worker.mjs` refuses a non-read under
`/api` outright, and the four dangerous reads by path - a credential download, a request
log and a diagnostic bundle - before the dataset is consulted, so a write cannot be
answered by a coincidence of path matching.

Unknown API paths answer a shaped 404 rather than an empty success, because a route that
fell through to a default would render a page carrying another page's numbers.

## A third-party script on the page is expected

Cloudflare injects its Real User Measurement beacon (`static.cloudflareinsights.com`)
into the HTML of this plan, so a browser opening the demonstration requests that origin.
It is not in this repository and not in the build output - the origin returns HTML
without it and the edge adds it - which makes it easy to mistake for a defect when a
network panel shows an unfamiliar host.

It was accepted knowingly. The claim this project needs is about its own code, and it
still holds: the Worker answers from the dataset and forwards nothing, so no provider is
ever contacted. Suppressing the beacon is possible - `Cache-Control: no-transform` on the
documents stops it, measured - and is deliberately not done, because the beacon was
judged acceptable and a suppression the project does not want would be a claim the
repository does not mean. ADR 0021 records the decision.

## Troubleshooting

**A page renders but its panel is empty.** Its read has no dataset entry, or the entry
was captured without the window the page asks for. `pnpm check:demo` names the route; the
fix is an export case in `internal/api/demo_export_test.go` and a regeneration.

**The dates look old.** The re-basing is not reaching a field. Add the name to the
instant rules in `time.mjs` rather than extending the list of captured fields: the
convention is `*_at_ms`, and a field that does not follow it is worth renaming.

**`pnpm demo:generate --check` fails immediately after a merge.** Someone changed a source
file the dataset derives from. Regenerate, read the diff, and commit the data with the
change - which is exactly what the gate is for.

**The local server will not start.** Delete `deploy/cloudflare/.wrangler` (it is ignored
per-machine state) and run `pnpm install` again, which fetches the runtime binary the
local server needs.
