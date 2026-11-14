# Updates

The console tells you when Oh My CPA or your gateway has a new release, and on a
container deployment with an updater it applies the update for you. The operator steps
are in [Upgrading](../install/upgrade.md); this page explains how the checks and the
updater behave.

## Update checks

The System Information page reports the running and published versions of both Oh My
CPA and your gateway. It reads release metadata from `api.github.com` only — fixed host,
no operator-supplied URL — using the OMC outbound network policy. A sweep runs on the interval chosen in OMC Settings → Update checks — hourly by
default, adjustable from fifteen minutes to a day; opening the page and the
**Check for updates** button also check, subject to a fifteen-minute floor per product —
inside it the answer comes from the stored index and the message says so, because the feed
is one shared per-address budget. A refused read — including a 429 — is reported on the page
and the next sweep asks again: an exhausted budget delays a release notice, it never ends
the checks.

When either product has a newer published release, the **System Information** entry in
the navigation carries a small amber dot. It reflects the stored answer and costs no
request of its own, so it appears once a sweep or a check has found the release. An open
console subscribes to a signal-only stream (`/management/system/live`) that says the stored
answer changed, re-reads once whenever the stream opens again (a tab returning from the
background, or the stream's five-minute lifetime ending), and keeps an hourly re-read as the
fallback for a deployment whose stream is unavailable. **Ignore this version** on the product's row clears the
dot for that one release and is remembered by the deployment, not the browser; pressing it
again restores the reminder, and a later release is flagged regardless.

The background sweep also checks installed plugins through CPA's store, once at startup
and on the same interval. The **Plugin Management** entry uses the same amber dot for available
plugin updates. The installed-plugins page enables a separate store query after its
list contains plugins. Installation or removal refreshes the reminder.

The header's GitHub link shows the project's star count, read by the server from the same
host and held in memory. It costs at most one request an hour: the sweep refreshes it, and
so does a console page load when page-load checks are allowed. With both switches below
off, or until a first read has succeeded, the link simply shows no count. Once a read has
succeeded the count stays for the life of the process: a refresh that fails keeps the
previous count.

Two switches, because they answer different questions.
`OMCPA_UPDATE_CHECK_ENABLED=false` stops the sweep on an offline deployment; the page
then keeps working from the last answer it stored, and a check that fails is reported
with its reason and the time it was attempted.
`OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false` additionally stops the check the page performs
when it is opened, which is what an air-gapped or test deployment wants, since a page
visit is not an operator asking a question. The **Check for updates** button works
either way. GitHub's unauthenticated budget is 60 requests per hour for the address
making them, and the page says so when a check is refused for that reason. The checks use the
gateway's own GitHub token — Configuration → Access & Auth → GitHub token
(`server.github-token`) — so a deployment configures GitHub once and both processes benefit:
a token raises that budget to 5,000 and exempts conditional requests from it. OMC reads it
from the gateway's configuration, holds it in memory, and never returns it to a browser.
Release notes
are held in memory rather than stored, so after a restart the page names the versions
and links to the source while the notes themselves are unavailable.

## Console updates

On a container deployment with an updater, the System Information page offers
**Update now** beside a product that has a newer release. [Upgrading](../install/upgrade.md)
is the operator's guide, including the one command that adds an updater to a deployment
that predates it.

The updater is the Oh My CPA image run as `oh-my-cpa updater serve`. It listens on
`:8090` inside the Docker network and publishes no port. Its settings are read from its
own environment, and an installation needs none of them.
Its settings are listed under [Updater](../reference/environment.md#updater).

Security boundary:

- The updater holds the Docker socket, which is control of Docker on that host. The
  console does not, and stays read-only and unprivileged. Anyone who can already run
  `docker` on the host gains nothing; anyone who can reach the updater's port without
  its token gets `401`.
- The token is an HMAC of `OMCPA_MASTER_KEY`. Neither container stores it, and it is
  not logged. Changing the master key needs no step here: the updater reads the
  console's current value from Docker.
- The updater accepts a product name and an optional route from OMC Settings → Network
  proxy: a proxy URL, `direct`, or nothing for the daemon's own configuration. It
  validates the proxy's protocol and address before downloading.
  It never takes an image, a container name or a command from the console.
  It identifies the two products from Docker state and
  refuses to upgrade an image pinned to a version tag or digest. Replacing a namespace
  owner also recreates its running `network_mode: container:<owner>` dependents, even
  across Compose projects; stopped containers are left alone.
- Oh My CPA is replaced only by the image a release's signed manifest names, and never
  by an older version. CLIProxyAPI is an upstream image this project cannot sign: its
  update pulls the tag the container already uses.
- A build without the release public key reports `signature_unavailable` and offers no
  console update for Oh My CPA.

Namespace rebinding preserves each dependent's exact running image, mounts and settings;
it does not resolve a floating tag again. The `io.oh-my-cpa.image-reference` container
label retains the configured image reference while Docker records an immutable image ID,
so future update discovery and version pins keep their meaning. An updater following a
signed console update may use that verified image; a pinned updater keeps its own image.

Automatic rebinding supports direct dependents of a container-owned namespace. Updates
are refused before pulling or stopping anything if a running container joins indirectly
through another dependent, or if the target itself uses a shared or host namespace and
has dependents. Configure shared helpers to reference the actual namespace owner
directly, or recreate this topology on the Docker host.

An existing `<name>-omc-previous` backup blocks another update before mutation unless
it is already stopped, the target container is healthy, and cleaning it up requires
no updater self-handover, in which case the updater removes that stale backup first.
When a self-handover cannot start its successor, the running predecessor restores the
previous owner and retries from that live namespace. If that restore also fails, recover
the updater from the Docker host rather than restarting it in the dead namespace. In the
ordinary interrupted-replacement case, restart the updater to run startup recovery before
retrying that product. New jobs are refused while the current updater is handing over to
its successor.

Dependents rejoin in Compose dependency order. They must also rejoin after a failed owner
update restores the original container, because restarting that owner creates a new
network sandbox. The owner backup remains until rebinding finishes, or until the
successor updater completes startup recovery. A helper failure is reported in the job
without blocking the updater's own handover. A dependent that cannot rejoin remains
stopped under its original name and needs to be recreated on the Docker host. Containers
that were already stopped before the update are not started by this process.

Network use: applying an Oh My CPA update makes the console download
`release-manifest.json` and its `.sig` from the release's assets on `github.com`,
following redirects only to GitHub's own asset hosts over HTTPS, through the same proxy
settings as the update check. By default, the Docker daemon pulls images using its own
registry and proxy configuration.

**OMC Settings → Network proxy** chooses the outbound route. The default follows the
existing deployment: OMC uses its environment, CPA retains its configuration, and the
Docker daemon pulls images. Choosing a proxy or direct route also sets CPA's
`requests.proxy-url` through the normal revision-checked, audited configuration write
and encrypted backup; returning to the default withdraws only a value OMC wrote,
leaving a proxy configured in CPA untouched.
CPA's individual provider and OAuth proxy choices remain independent. A CPA write and
OMC's settings save cannot be one transaction; a partial failure is reported and requires
a reload. If CPA's configuration is changed elsewhere, the settings page reports the mismatch;
applying the OMC setting reconciles it.

A selected proxy applies to OMC's release and manifest reads, price and currency sync,
font downloads, and provider probes without their own proxy. OMC exclusions apply to
the console's requests; CPA's proxy configuration does not support this exclusion list,
and an image download sends every registry request through the proxy.
Browser-loaded plugin artwork and independently operated clients use their own networks.
The proxy address must be reachable from OMC, CPA, and updater namespaces: `localhost`
inside one container is not another container. Only an encrypted OMC settings record is
stored in SQLite; a proxy configured in CPA also resides in CPA's configuration.

When the selected route is proxy or direct, the updater downloads the registry manifest
and layers, selects the daemon's platform, and streams a verified archive into Docker.
OMC's signed index digest and image content hashes are verified before replacement. The
daemon's proxy configuration is not changed. A standalone updater can temporarily join
a console network containing the proxy container and removes its own attachment before
replacement. Proxy failure never triggers a direct retry. The console and updater both
need builds supporting the selected route; an older updater needs an independent upgrade —
rerun its install command, or switch to the deployment default route, update the console,
and switch back.
The authenticated console-to-updater control connection uses HTTP by default, so place
that network on trusted infrastructure or provide transport encryption.

Remote backup destinations also have their own network adapters. HTTP-based S3, WebDAV,
Google Drive and OneDrive destinations can use an explicit proxy when no OMC exclusions
are configured. Other managed routes, including SMB, and routes whose exclusions cannot
be guaranteed are refused rather than silently connected directly. With a selected direct route,
SMB, SFTP and FTP destinations connect directly; HTTP-based destinations are refused
because their adapters can inherit an environment proxy. Local backups remain available;
backup OAuth exchanges use OMC's HTTP policy.

Audit: `system.update.apply` records the admission, or the refusal with its reason,
before the updater is asked; `system.update.completed` records how that admission ended:
the job's outcome, or the updater's refusal or silence when no job started. An Oh
My CPA update, or a CLIProxyAPI update when the console shares its network namespace,
ends the process that admitted it, so the next process follows the job from start-up and
records the outcome once the updater reports it finished.
