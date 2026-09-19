# The Vercel demo deployment

The public demonstration runs the ordinary binary in demo mode as a Vercel container
image. This is the runbook: what the repository contains, what the platform does with
it, what has to be arranged once in the console, and how to check that it is healthy.

The demonstration itself - what it refuses, what it serves, how its data is built -
is `docs/architecture.md` §12 and ADR 0016. This document is only about running it.

## What the repository provides

| File | Role |
| --- | --- |
| `Dockerfile.vercel` | The image the platform builds and routes to. Multi-stage: the SPA is built with Node, embedded into the Go binary, and only the binary reaches the runtime stage. |
| `deploy/vercel/entrypoint.sh` | Follows the platform's `PORT` at start-up. The platform routes to the port it announces, and to `80` when it announces nothing, so a demo needs no project configuration at all. |
| `vercel.json` | Declares the image as a container service and exposes it with a catch-all rewrite. |

`Dockerfile` is the self-hosted image and is not involved. Neither image reads the
other's configuration.

Demo mode is switched on by the image's own environment (`OMCPA_DEMO_MODE=true`,
plus the base path, the temporary data directory and the version string). Setting it
in the project's environment variables as well is harmless and unnecessary.

## Deploying

```bash
vercel link --project oh-my-cpa-demo          # once per machine
vercel deploy                                 # preview
vercel deploy --prod                          # production
```

A deployment takes about two minutes: the frontend build dominates, and the runtime
stage carries a ~31 MB image. The first request after a cold start waits for the
fixture - about four seconds - after which the instance stays warm for five minutes
of traffic.

## Platform setup, once per project

Three settings stand between the repository and a working demo. The first has no API:
it authorizes an account rather than configuring a project, so it is the one step that
has to happen in a browser. The other two can be done either way.

1. **Add a GitHub login connection to the Vercel account.** Vercel only links a Git
   repository when the account has GitHub authorized, and until it is, both
   `vercel link` and `vercel git connect` fail with
   `You need to add a Login Connection to your GitHub account first`.
   Account settings → Login Connections → GitHub. Authorizing GitHub as a *login
   method* is what installs the app that can see this repository.
2. **Connect the project to the repository.** Either from the Vercel dashboard
   (Project → Settings → Git → Connect Git Repository) or with
   `vercel git connect --scope <team>`. Only after this does pushing a branch create
   a Preview deployment and pushing `master` update production.
3. **Set the project's framework to Services.** `vercel.json` declares the container
   under `services`, and the platform builds the container only when the project is in
   that mode. A project created from the dashboard may need Settings → Build &
   Development Settings → Framework Preset → Services. This runbook's project was set
   with `PATCH https://api.vercel.com/v9/projects/<project>?teamId=<team>` and
   `{"framework":"services"}`. (`vercel link --yes` and `vercel deploy` do the rest:
   they created and deployed this project without touching the console.)

Two platform defaults are worth knowing rather than changing:

- **Production is public; preview deployments are protected** by Vercel
  Authentication, so a preview link opens for a signed-in member of the team and
  redirects everyone else. Open previews (Settings → Deployment Protection → Vercel
  Authentication → off) if a preview has to be reachable by anyone with the link.
- **The container scales to zero.** Nothing in the demo persists, so this is
  invisible except as a cold start.

No environment variable has to be set for the demo to work. If one is set for another
reason, the image's own defaults are overridable in the usual way
(`OMCPA_BASE_PATH`, `OMCPA_DATA_DIR`, `OMCPA_VERSION`, `OMCPA_LISTEN_ADDR`), and
`OMCPA_MASTER_KEY` is honoured when supplied - it is otherwise minted per process.

## Checking a deployment

```bash
curl -s https://<deployment>/api/healthz          # {"cpa_connected":true,...}
OMCPA_DEMO_URL=https://<deployment> pnpm verify:demo
```

`pnpm verify:demo` is the same browser suite CI runs against a locally started demo:
it walks every console page, asserts each one renders its own fixture data with no
failed request and no script error, reaches the refused endpoints with `fetch` rather
than through the page, and performs one permitted edit to see the console report that
it is not durable. Against a remote deployment it skips starting a server and
verifies the deployment itself.

A healthy demo reports `cpa_connected: true` and `status: ok`. That is not a claim
about a real gateway: in demo mode the instance row points at the in-process fixture,
which is what makes the health check meaningful - it proves the fixture is up.

## Failure modes worth recognising

| Symptom | Cause |
| --- | --- |
| `Build logs say no functions or static directory` | Normal for the container path; inspect the deployment instead of the warning. |
| Build fails looking for an output directory (`public`) | The project is not in Services mode, so `vercel.json`'s `services` block is inert and the platform treated the repository as a static site. See step 3. |
| The site answers `404` while the deployment is ready | No rewrite reaches the service. A service is private until a top-level rewrite routes to it. |
| Every page loads and then falls back to the sign-in card | The session cookie is not surviving. The demo issues one per request for exactly this reason; a regression there is what to look for. |
| The dashboard's short windows are empty | The fixture did not rebuild. It deletes and re-seeds `oh-my-cpa-demo.db` on every boot; a stale database means the reset did not run. |
| `Permission denied` on `/tmp` or the data directory | The image's `OMCPA_DATA_DIR` was overridden with a path the platform does not mount writable. Only `/tmp` is. |

## Cost

One container function, no database and no marketplace service: on the Hobby plan this
is inside the included allowance for a demo's traffic. Vercel meters function usage
rather than a fixed bill - invocations, provisioned memory and active CPU (the time the
code is actually running, not the time it spends waiting) - so the figure follows how
much the demo is used. A deployment that is scaled to zero accrues nothing.
