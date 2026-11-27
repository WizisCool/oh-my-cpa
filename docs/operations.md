# Operations

Day-to-day running of an installed console: what each task is, and the rules a deployment
must keep. Every setting is listed in [Environment variables](reference/environment.md).

| Task | Guide |
| --- | --- |
| Change the port or keep data in a host directory | [Ports and storage](operate/ports-storage.md) |
| Release notices and one-click updates | [Updates](operate/updates.md) |
| Back up, restore and recover the database | [Backup and restore](ops/sqlite-operations.md) |
| Keep the master key safe, rotate the management key | [Keys](operate/keys.md) |
| Choose the calendar for daily statistics | [Time zone](operate/time-zone.md) |
| Audit outbound hosts, triggers, and offline behavior | [External requests](#external-requests) |

## Deployment constraints

- **Single replica**: SQLite WAL requires exclusive single-process access. Run one
  replica mounting the data directory; do not mount over network filesystems
  (NFS/CIFS).
- **Master key**: `OMCPA_MASTER_KEY` is required to decrypt stored credentials and
  payloads. Back it up securely.
- **Framed content**: The console's document declares `frame-src 'self' blob:`. It frames plugin pages from its own origin; a reverse proxy must not replace that policy with one that allows other frame sources.
- **Network security**: Keep CPA on a private network or loopback interface. The supplied
  Compose files publish CPA and OMC only on loopback; use direct local access or an SSH
  tunnel. Public access requires HTTPS through operator-owned infrastructure.
- **Reverse proxy headers**: Set `OMCPA_TRUSTED_PROXY_CIDRS` to the CIDRs of reverse
  proxies whose forwarding headers may be trusted. Both Compose files default to an
  empty trust list. Name only actual proxy peers; leave it unset for direct clients;
  never trust a public range.
- **Gateway version**: The console requires CPA v8.0.0 or later and speaks its v8
  Management API; a gateway older than v8 is refused and every page shows upgrade
  guidance instead. CPA v8 reads an existing v7 `config.yaml` unchanged, so upgrading
  CPA needs no configuration change. The console's first configuration save converts
  such a file to the v8 layout, after keeping an encrypted copy of the original that the
  configuration page offers for download (see [CPA contract](cpa-v8-compat.md)). Payload
  replacement `system`/`developer` roles, `target.paths`, and `{ pattern, replacement }`
  regex entries require CPA v8.0.77 or later; v8.0.75–v8.0.76 support only `role: user`
  with literal mappings, and versions earlier than v8.0.75 do not support payload
  replacement.
- **Gateway configuration**: Omitted request retries and maximum cooldown wait
  both mean `0`; the example's `3` and `30` apply only when explicitly configured.
  Header passthrough forwards filtered upstream response headers to clients.
  See the configuration editor for supported settings and [CPA integration](cpa-v8-compat.md) for write semantics.
- **Base path**: New installations serve the console at `/`. A configured
  `OMCPA_BASE_PATH` is served with a trailing slash; OMC answers the bare prefix with
  a 308 redirect to it. An operator-owned proxy must preserve a configured prefix and
  route both the bare prefix and everything beneath it. At the root, the proxy forwards
  the site unchanged (`deploy/nginx.conf` and [Remote access](install/remote-access.md#reverse-proxy) show examples); CPA
  keeps its separate port regardless of OMC's base path. A deployment copied from an
  older minimal example that relied on the former implicit `/omc` default without
  setting the variable must add `OMCPA_BASE_PATH=/omc` before replacing the image if
  it must retain that URL.
- **Search engines**: Every response carries `X-Robots-Tag: noindex, nofollow, …`, which
  is what keeps a publicly proxied console out of search results. Crawlers read
  `robots.txt` only at the origin root; OMC answers it there and under a configured base
  path, so a proxy that forwards only the prefix and wants the advisory file too must
  also route `/robots.txt` to OMC.
- **Container image**: Compose pulls `wiziscool/oh-my-cpa:latest` from Docker Hub by
  default; the full-stack CPA image also defaults to `:latest`. Pin `OMCPA_IMAGE` to the desired version or digest; updates recreate only
  OMC with its existing data and master key. The image runs as non-root uid/gid `10001:10001`
  by default (overridable via `OMCPA_USER` in the supplied Compose files when matching a
  host bind mount), includes its own health probe and needs no mounted deployment scripts. A health
  result of `degraded` keeps the container healthy but does not establish CPA access.
- **Existing CPA and panels**: OMC-only Compose can attach to an existing external
  Docker network. It does not replace the gateway or other panels; collection ownership
  must be resolved separately. See [Standalone](install/standalone.md#other-management-panels).

## External requests

The table below lists every built-in outbound HTTP(S) request initiated by the Oh My CPA
server, browser SPA, or `oh-my-cpa-updater` sidecar. Server-initiated downloads follow
**OMC Settings → Network proxy** (`internal/outbound/proxy.go`); browser-initiated requests
use the visitor's browser network directly; `OMCPA_DEMO_MODE=true` disables background
refresh loops and refuses server-initiated external calls.

Operator-configured targets sit outside this built-in list: the configured CPA gateway
(`OMCPA_CPA_BASE_URL`, `OMCPA_CPA_USAGE_ADDR`), the local updater sidecar
(`OMCPA_UPDATER_URL`), operator-entered provider endpoints during manual connectivity probes
(`30s`, `internal/api/management_provider_probe.go`, defaulting omitted base URLs for Claude,
Gemini, and Vertex to `api.anthropic.com`, `generativelanguage.googleapis.com`, and
`aiplatform.googleapis.com`) and model-list pulls (`15s`,
`internal/api/management_provider_models.go`), remote database backup destinations and their
Google Drive or OneDrive OAuth flows (`internal/backup/rclone_destination.go`,
`internal/backup/oauth.go`, `30s` exchange timeout including
`https://graph.microsoft.com/v1.0/me/drive` for OneDrive), and external hyperlinks opened on
user click.

| Purpose & endpoint (override) | Initiator | Trigger & frequency | Timeout & retry | Degradation / fallback | Code path |
| --- | --- | --- | --- | --- | --- |
| **Model pricing & specs** — `https://openrouter.ai/api/v1/models?output_modalities=all` (fixed; `32 MiB` cap) | Server | Startup, then every `24h` by default (configurable `1`–`168h` or `0` to disable scheduled ticks); manual sync (`POST /api/v1/pricing/sync`); `5m` catalog reconciliation reuses the `15m` in-memory cache and SQLite snapshot, fetching only when SQLite holds no snapshot and an unpriced model exists | `20s` HTTP timeout (`2m` sync run deadline); no immediate retry, retries on next scheduled tick or manual sync | Retains the last stored OpenRouter catalog and synced prices in SQLite; manual prices and pinned links remain intact; Model Square metadata reads the local cache only | `internal/pricing/openrouter.go`, `internal/pricing/service.go`, `internal/remotedata/fetch.go` |
| **Display currency exchange rates** — `https://api.frankfurter.dev/v2/rates?base=USD` (fixed; `1 MiB` cap; redirects refused) | Server | Startup when elapsed time since stored `attempted_at_ms` meets the interval, then every `24h` by default (configurable `1`–`168h` or `0` in OMC Settings); manual refresh (`POST /api/v1/exchange-rates/refresh`) | `20s` HTTP timeout (`30s` refresh context); fetch failures advance `attempted_at_ms` and wait one full interval (`5m` retry only on local SQLite read/write errors) | Retains the last complete snapshot in SQLite across offline periods and restarts (rejecting partial payloads); USD accounting continues and uncached non-USD amounts render `—` | `internal/exchangerate/frankfurter.go`, `internal/exchangerate/service.go`, `internal/exchangerate/policy.go`, `internal/remotedata/fetch.go` |
| **OMC & CPA release feeds** — `https://api.github.com/repos/<owner>/<name>/releases?per_page=30&page=1..2` (fixed host `api.github.com`, same-origin redirects only; repos default to `WizisCool/oh-my-cpa` and `router-for-me/CLIProxyAPI`, overridable via `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO`; sends CPA `server.github-token` when set; `4 MiB` per page) | Server | Background sweep after first interval when `OMCPA_UPDATE_CHECK_ENABLED` is `true` (boolean switch, default `true`; interval configured in **OMC Settings** auto-refresh controls, default `60m`, range `15m`–`24h` or `0`); System Information load (`OMCPA_UPDATE_CHECK_ON_PAGE_LOAD`) and manual check (`POST /api/v1/management/system/check-updates`), both bounded by a `15m` per-product attempt floor; up to 2 pages per product (`If-None-Match` on single-page cache) | `15s` per request; no immediate retry (failed attempts advance the `15m` floor and wait for the next sweep or post-floor check) | Keeps the last stored release index in SQLite and surfaces the redacted `check_error`; release notes live in memory only and stay unavailable while offline or after restart | `internal/release/github.go`, `internal/release/service.go`, `internal/release/policy.go`, `internal/api/management_system.go` |
| **Repository stargazer count** — `https://api.github.com/repos/WizisCool/oh-my-cpa` (fixed host and repo; sends CPA `server.github-token` when set; `1 MiB` cap) | Server | End of each background release sweep (`OMCPA_UPDATE_CHECK_ENABLED`) and header mount (`GET /api/v1/management/system/repository`, gated by `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD`); `1h` in-memory attempt floor across all callers | `5s` context timeout (within `15s` client timeout); no retry (failed attempts advance the `1h` floor; browser query sets `retry: false`) | Returns HTTP `200` with `stargazers_count: null` (plain GitHub link without badge) before first success; keeps the last in-memory count across later failures | `internal/release/stargazers.go`, `internal/api/management_system.go`, `web/src/components/common/HeaderNav.tsx` |
| **GitHub token rate-limit probe** — `https://api.github.com/rate_limit` (fixed host `api.github.com`; redirects refused; `64 KiB` cap) | Server | On-demand only when testing a candidate or configured GitHub token (`POST /api/v1/management/github-token/test`) | `15s` timeout; no retry | Returns a structured `invalid` or `error` diagnostic without modifying saved CPA configuration | `internal/release/rate_limit.go`, `internal/api/management_github_token.go` |
| **Signed OMC release manifest & signature** — `https://github.com/<owner>/<name>/releases/download/<tag>/release-manifest.json` and `.sig` (repo via `OMCPA_OMC_REPO`; up to 2 HTTPS redirects only to `objects.githubusercontent.com` or `release-assets.githubusercontent.com`; `64 KiB` cap each) | Server | On-demand only when applying an Oh My CPA container update (`POST /api/v1/management/system/updater/apply`) | `15s` per file; no retry | Fails closed with HTTP `502` (`manifest_unavailable` or `manifest_missing`) and records an audit entry; running containers remain untouched | `internal/release/manifest.go`, `internal/api/management_system_updater.go` |
| **Google Fonts server installer** — `https://fonts.googleapis.com/css2?...` (overridable via `OMCPA_GOOGLE_FONTS_URL`) plus referenced font files on `fonts.gstatic.com`, `fonts.gstatic.cn`, `fonts.googleapis.com`, `fonts.googleapis.cn`, or the mirror's own site (up to 2 redirects; caps: `2 MiB` CSS, `600` faces, `32 MiB`/file, `96 MiB` total) | Server | On-demand only when installing a Google Fonts family in Settings (`POST /api/v1/fonts/google`); installed faces are stored in SQLite and served from OMC's own origin afterward | `3m` total install timeout (`4m` HTTP handler deadline), up to 8 concurrent face downloads; single fallback from `:wght@400;700` to bare family name on CSS `400`/`404`; no transport retry | Returns HTTP `404` or `502` without altering stored fonts; previously installed fonts and offline local uploads (`POST /api/v1/fonts/upload`) continue working | `internal/fontasset/google.go`, `internal/api/fonts.go` |
| **Browser CJK fallback fonts** — `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&display=swap` and referenced `https://fonts.gstatic.com/...` `.woff2` slices (fixed; `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`; independent of `OMCPA_GOOGLE_FONTS_URL`) | Browser | Once per visible browser session on load, lazily downloading `.woff2` slices for CJK/Hangul code points outside bundled Sarasa Mono SC shards; on-demand during conversation HTML/PNG and dashboard receipt PNG exports to inline needed slices | `8s` timeout (`AbortSignal.timeout(8000)`) on explicit stylesheet and export fetches; normal rendering registers URL-backed `FontFace` objects whose `.woff2` loads follow browser defaults; no automatic retry loop (failed stylesheet load clears its cached promise so a later export can try again) | Silently registers no remote faces and falls back to bundled Sarasa shards plus local OS CJK fonts; console rendering and exports succeed | `web/src/theme/cjkFont.ts`, `web/src/main.tsx`, `web/src/agent/conversationDownload.ts`, `web/src/components/dashboard/receipt/receiptImage.ts` |
| **Publisher-declared plugin logos** — optional `http://` or `https://` artwork URLs from CPA plugin metadata (`logo`, `metadata.logo`, `oauth_provider_entries[].logo`; userinfo rejected; `data:image/` URIs make no request) | Browser | On-demand when rendering plugins or plugin-registered OAuth providers (`<img referrerPolicy="no-referrer">`), and via `fetch()` during usage request-sheet PNG export; uses standard browser HTTP caching | Standard browser image/fetch timeouts; no custom retry | Page views fall back automatically to a bundled provider icon or neutral puzzle icon without blocking rendering; request-sheet PNG export awaits the artwork `fetch()` before drawing, so an unresponsive host can delay export until the browser timeout and the neutral export-box fallback appears only after the request fails | `web/src/types/pluginOAuthProviders.ts`, `web/src/components/plugins/PluginIcon.tsx`, `web/src/components/common/MarkArtwork.tsx`, `web/src/components/common/RemoteImage.tsx`, `web/src/components/usage/requestSheetPainter.ts` |
| **OpenUI external images & source favicons** — optional `http://` or `https://` image URLs rendered by `@openuidev/react-ui` components (such as source favicons) or emitted in an Agent `present_openui` answer (`Referrer-Policy: no-referrer`) | Browser | On-demand when viewing live Agent `present_openui` answers and during off-screen rendering for HTML/PNG conversation exports (including interfaces not currently visible), before export cleanup strips non-inline URLs for the saved file | Standard browser image timeouts; no custom retry | Failed images degrade to browser alt/fallback layout without blocking the console; saved standalone HTML exports strip non-inline asset URLs and enforce `img-src data:` | `web/src/pages/agent/tools/openui.tsx`, `web/src/agent/openui/staticRender.tsx`, `web/src/agent/conversationDownload.ts`, `web/src/agent/openui/exportMarkup.ts`, `web/src/agent/conversationHtml.ts` |
| **Container image pulls** — container registry for running OMC (`wiziscool/oh-my-cpa` by verified `@sha256:...` digest) and CPA (`eceasy/cli-proxy-api` by configured tag) images (Docker Hub `registry-1.docker.io` / `auth.docker.io` and blob redirects, or the container's custom registry) | Updater sidecar (`oh-my-cpa-updater`) or host Docker daemon | On-demand only when applying an update on an unpinned container deployment (`POST /api/v1/management/system/updater/apply`, `OMCPA_UPDATER_ENABLED=true`); default route delegates to Docker (`POST /images/create`), while `proxy` or `direct` routes pull in the sidecar and stream into Docker (`POST /images/load`) | `30m` download timeout for sidecar `proxy` / `direct` pulls via `go-containerregistry` (proxy failures never fall back to direct); Docker daemon defaults on deployment-default route (`45m` console job watch limit) | Job ends in `failed` before modifying running containers, or rolls back if replacement health verification fails (`OMCPA_UPDATER_HEALTH_TIMEOUT`, default `5m`) | `internal/updater/service.go`, `internal/updater/engine.go`, `internal/updater/proxy_image.go` |

### External endpoints delegated to CPA

Several external URLs appear in OMC source files because OMC manages CPA configuration or calls CPA management endpoints while **CPA** performs the actual outbound fetch:

- **CPA model catalogs (`models.router-for.me`)**: `https://models.router-for.me/models.json`, `https://models.router-for.me/codex_client_models.json`, and `https://models.router-for.me/devin_models.json` appear in `web/src/types/configSchema.ts` only as field placeholders for CPA's `models.catalog`, `models.codex-catalog`, and `models.devin-catalog` settings. Clicking **Refresh catalogs** in Model Square (`internal/api/model_square_refresh.go`, `internal/cpa/management/client_model_definitions.go`) invokes CPA (`POST /v8/management/routing/model-definitions/refresh`), and CPA fetches those catalogs.
- **Oh My CPA plugin registry (`raw.githubusercontent.com`)**: `https://raw.githubusercontent.com/omc-community/omc-plugins/main/registry.json` (`internal/pluginregistry/registry.go`) is reconciled into CPA's `plugins.store-sources` (`internal/api/management_plugin_source.go`) while the OMC plugin source toggle is enabled. CPA downloads the registry and plugin packages; OMC's scheduled and manual plugin-update checks (`internal/api/management_plugins.go`) query CPA's management API only.
- **Provider OAuth quota and subscription endpoints**: Upstream URLs allowlisted in `internal/quota/service.go` and `internal/quota/devin.go` (`chatgpt.com`, `api.anthropic.com`, `daily-cloudcode-pa.googleapis.com`, `daily-cloudcode-pa.sandbox.googleapis.com`, `cloudcode-pa.googleapis.com`, `api.kimi.com`, `api.kimi.ai`, `cli-chat-proxy.grok.com`, `api.x.ai`, `api.meta.ai`, `server.codeium.com`) are dispatched through CPA's `api-call` management endpoint so CPA executes them with its managed credentials.

See [Updates](operate/updates.md) for outbound proxy routing across OMC, CPA, and the updater, and [Environment variables](reference/environment.md) for every environment toggle.
