# Remote access and HTTPS

Every Compose file here publishes on `127.0.0.1` only. From another machine, tunnel over
SSH and open `http://127.0.0.1:18080/`:

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

To serve OMC over HTTPS, point your reverse proxy at `127.0.0.1:8080` (or the custom host
port set in `OMCPA_BIND`), forward the site root unchanged, and set `OMCPA_PUBLIC_URL` to
the external `https://` address browsers use. Set `OMCPA_TRUSTED_PROXY_CIDRS` to the
proxy's IP/CIDR so OMC reads the forwarded client IP. Do not publish port 8080 on a
public interface without TLS: the sign-in password is CPA's administrator key.


## Reverse proxy

OMC embeds both the web UI and the `/api/*` backend in a single server listening on one
port (`127.0.0.1:8080` by default). Unlike split frontend/backend setups, **you only need
to proxy one upstream port** for OMC, and the root path `/` requires no path stripping or
prefix rewrite. (CPA itself stays on its separate gateway port `8317` if you also proxy
client API traffic on another hostname.)

Caddy:

```caddyfile
omc.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx (terminate TLS in this `server` block and redirect HTTP to HTTPS; see `deploy/nginx.conf` for an upstream Docker-network template):

```nginx
server {
    listen 80;
    server_name omc.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name omc.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

When serving over HTTPS behind a reverse proxy, add the public URL and the proxy peer
IP/CIDR that OMC sees on the incoming TCP connection in `.env` and recreate `oh-my-cpa`
(in Docker bridge mode, requests from a host proxy arrive from the Docker bridge gateway
IP rather than `127.0.0.1`; `127.0.0.1/32,::1/128` applies when the proxy and OMC share
the same network namespace, such as a native install):

```dotenv
OMCPA_PUBLIC_URL=https://omc.example.com
OMCPA_TRUSTED_PROXY_CIDRS=<proxy-peer-ip-or-cidr>
```

Check the root through the proxy:

```bash
curl -fsS https://omc.example.com/api/healthz
```

If `OMCPA_BASE_PATH` is set to a sub-path (such as `/omc`), configure the proxy to
preserve that prefix and forward both the bare prefix and everything beneath it.

## Install as an app

The console is an installable web app: Chrome and Edge on desktop and Chrome on Android
install it from the served page, Samsung Internet does the same on Samsung devices, and
iOS and iPadOS add it to the Home Screen. It then opens in its own window with the brand
mark as its icon, instead of in a browser tab.

Installation is a browser feature, not a console setting, so there is no install button
to look for on a page:

| Where | How |
| --- | --- |
| Chrome or Edge on a computer | The install icon in the address bar, or the browser menu → **Install page as app** / **Apps → Install this site as an app** |
| Chrome on Android with Google Mobile Services | Menu → **Install app** (or **Add to Home screen**) |
| Samsung Internet on a Samsung device | **Add to Home screen** |
| Safari on iOS or iPadOS | Share → **Add to Home Screen**. There is no in-page install prompt, and the console cannot open the Share sheet for you. On iOS and iPadOS 16.4 or later, the Share menu of Chrome, Edge, Firefox and Orion installs it too |
| Safari on macOS | **File → Add to Dock** (Safari 17 on macOS 14 or later) |

Two conditions come from the browser rather than from OMC:

- **Chromium's install criteria require a secure context.** Chrome and Edge treat the
  console as installable only when it is served over `https://` through your reverse
  proxy, or over `http://localhost` / `http://127.0.0.1` during local development. A
  plain-HTTP deployment reached by a LAN IP or hostname does not meet that criterion,
  even though the console itself works there. Do not expose the console over plain HTTP
  on a network interface: the sign-in password is CPA's administrator key.
- **The deployment stays reachable.** The PWA adds no service worker and no offline
  cache of API responses or user content, so the installed app cannot load without a
  connection. Existing session and caching rules are unchanged: the sign-in session
  cookie and the hashed static assets keep the behavior they already have. Reinstalling
  is not needed to pick up an update; every launch loads the current bundle from the
  deployment.

The mount point is part of the installed identity. The root and each configured
`OMCPA_BASE_PATH` are different apps to the browser, so installing one does not
replace another, and an app installed at a path that later changes has to be installed
again. The manifest's URLs are relative and resolve against the manifest's own address,
which is what keeps this working behind a proxy that preserves the prefix.
