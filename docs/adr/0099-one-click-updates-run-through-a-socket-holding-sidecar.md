# ADR 0099: Console updates run through a socket-holding sidecar

Status: Accepted
Date: 2026-10-14
Supersedes: ADR 0057's consequence that existing containers do not update themselves and
operators explicitly pull and recreate the selected service. Its default of floating
`latest` images, its pinning guidance and its publication policy remain in force.

## Context

The console already knows when a newer release of Oh My CPA or CLIProxyAPI exists
(ADR 0019), but applying one meant a shell on the Docker host. Replacing a container
needs the Docker Engine API, and the console container is deliberately the opposite of
something that should hold it: read-only root filesystem, unprivileged user, every
capability dropped, and a large authenticated HTTP surface.

Deployments that already exist were written by hand from three different Compose
snippets, plus two release Compose files. A migration that asked each operator to edit
their file would be the last manual step most of them never took.

## Decision

**A second container holds the socket.** The same image runs as `oh-my-cpa updater
serve`: `internal/updater`, a small HTTP service with the Docker socket mounted, a
read-only filesystem, no capabilities and no published port. The console container is
unchanged. The Engine API is spoken with `net/http` over the unix socket; no Docker SDK
is added to the module.

**The updater's interface is two requests, neither of which names an image or a
container.** `GET /v1/status` reports what it found, and `POST /v1/update` takes a
product, `omc` or `cpa`. The updater resolves the console as the container that shares
its own image repository (in its own Compose project when it has one), and the gateway
as the container the console's `OMCPA_CPA_BASE_URL` points at. A gateway that is not a
container on that host is reported as such and never guessed at.

**Replacement is rename, create, verify, then remove.** The replacement's configuration
is derived from the running container minus everything its old image supplied, so the
new image's entrypoint, environment, health check and labels take effect while the
operator's settings, mounts, networks, aliases and Compose labels carry over. The old
container is stopped and renamed, not removed, until the replacement is healthy; a
replacement that exits or reports unhealthy is deleted, the old container gets its name
back and is started, and the image tag is pointed at the old image again.

**A pinned image is never changed.** A version tag or digest in the configured image
reference means the operator chose that version. Replacing the container anyway would be
undone by the next `docker compose up`, which would then start the pinned, older binary
over a database the newer one had already migrated, and migrations are forward-only.
Only floating tags are updated, and the tag is re-pointed locally so Compose sees no
drift afterwards.

**Console releases are verified by signature; gateway releases are not.** Each release
publishes `release-manifest.json`, naming the image repository and the multi-platform
digest, and an Ed25519 signature made with a key held in the release job's secret. The
public key is compiled into the binary. The console downloads both files and forwards
them unread; the updater verifies the signature, that the manifest names the repository
the console already runs, and that the version does not go backwards, then pulls by
digest. The gateway is an upstream project whose releases this project cannot sign, so
its update pulls the tag its container already uses and trusts the registry, exactly as
`docker compose pull` does. A build without the public key, which is any build from
source and any fork, reports that it cannot verify and offers no console update; it does
not fall back to an unverified one.

**The two containers need no shared setting.** The console looks for the updater at
`http://oh-my-cpa-updater:8090`. The bearer token is an HMAC of `OMCPA_MASTER_KEY`; the
console computes it from its own setting and the updater computes it from the console
container's environment, which it can read through the socket it already holds.

**Existing deployments migrate with one command.** `docker run --rm --pull always -u 0
-v /var/run/docker.sock:/var/run/docker.sock wiziscool/oh-my-cpa:latest updater install`
creates the updater as a container of its own on a network of its own, attaches the
console to that network, and upgrades the console to the installer's release. It is
placed outside the deployment's Compose project on purpose: a container Compose does not
know about, attached to a Compose network, makes `docker compose down` fail. The updater
re-attaches the console whenever Compose recreates it. New installs declare the updater
as a service instead.

**The updater replaces itself after it replaces the console,** so both run the same
release, and hands the finished job to its successor so the restarted console can still
read how its own update ended and record it.

## Consequences

- Whoever controls the updater container controls Docker on that host. This is stated in
  the install guides and in `SECURITY.md`, the service can be deleted from any Compose
  file, and `OMCPA_UPDATER_ENABLED=false` makes the console ignore one.
- A stolen console session can start an update to the signed current release of Oh My
  CPA or to the gateway's own tag, and nothing else. It cannot choose an image.
- The release job fails closed without its signing key, and the key pair is one more
  thing to keep: losing the private key means shipping a release with a new public key
  that existing installations must reach by hand once.
- Host maintenance stays outside the Agent capability surface
  (`docs/agent-capabilities.md`); an update is a console action with its own
  confirmation and audit events, `system.update.apply` and `system.update.completed`.
- Native installations are unaffected and keep the manual upgrade in `docs/install.md`.
- No database migration: a job lives in the updater's memory, and its outcome in the
  audit log.
