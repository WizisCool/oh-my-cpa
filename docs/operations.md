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
