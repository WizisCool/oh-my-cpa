# ADR 0060: Plugin pages are hosted same-origin through a scoped plugin host

- Status: Accepted
- Narrows the "no arbitrary CPA endpoint proxy" rule for one bounded surface; the DTO
  allowlist of ADR 0038 continues to govern every other management response.

## Context

A CPA plugin can register pages (`menus` on `GET /v8/management/plugins`). Each is an HTML
resource the plugin serves at `/v0/resource/plugins/<id>/...`, unauthenticated, and the
page calls the plugin's own management routes at `/v0/management/<route>`, which CPA guards
with the management key. CPA's management centre shows such a page in a same-origin frame
and the page reuses the key that console keeps in the browser.

Oh My CPA differs in three ways that make the same arrangement impossible as it stands:
the browser never holds the management key; the console is usually served under a
sub-path (`/omc`) of an origin that is not CPA's, so a page's CPA-root absolute paths do
not reach CPA; and the facade answers only projected DTOs, never raw CPA responses.

Existing plugin pages also assume their host: they build requests from
`location.origin`, and read the host's colour scheme from
`window.parent.document.documentElement`'s `data-theme`.

## Decision

Serve plugin pages through a **plugin host** under `<base>/api/v1/plugin-host/`, behind the
console session, and show them in a same-origin frame.

- `GET .../plugin-host/v0/resource/plugins/<id>/...` reads the plugin's resource from CPA
  without the management key, as CPA itself serves it.
- `GET|POST|PUT|PATCH|DELETE .../plugin-host/v0/management/<route>` calls a route a plugin
  registered, with the management key added by the server. The first path segment must
  not be one of CPA's own management roots (`config`, `config.yaml`, `auth-files`,
  `api-keys`, `logs`, `plugins`, `plugin-store`, ...; the list is
  `coreManagementSegments` in `internal/cpa/management/client_plugin_host.go`), so the
  host cannot be used to read a raw configuration, credential or log through the back
  door. Paths are cleaned and refused on traversal, backslashes and control characters.
- The page's own `Authorization`, `X-Management-Key` and cookies are dropped; only a short
  list of content headers is forwarded each way; `Set-Cookie` is never returned;
  redirects are not followed and a `Location` is re-based.
- HTML, CSS and JavaScript have their CPA-root references (`/v0/resource/plugins/`,
  `/v0/management/`) re-based onto the host prefix, and HTML receives a small script that
  re-bases the same prefixes at run time for `fetch`, `XMLHttpRequest` and `EventSource`.
- Every non-`GET` plugin route call is audited (`plugin.route_call`: attempt, then
  outcome), with the method and the status, never the body.
- The frame's parent is a console-written document carrying `data-theme="dark|light"`, so
  pages written for CPA's management centre follow the console's colour mode.
- Only a running plugin's pages are listed, only those under its own id, and demo mode
  refuses the whole surface.

## Trade-offs

**A plugin page runs with the console's authority.** Same-origin is what makes existing
pages work, and it means a page's script can call the console's API as the signed-in
operator. An opaque-origin sandbox was rejected because it breaks `location.origin`,
parent theme reads and storage, which the pages in circulation use. The trust decision is
therefore the install: a plugin already executes inside the gateway process with the
gateway's secrets, so its page is not a wider grant than the plugin itself, and the store
keeps the typed-id confirmation for third-party plugins. The management key still never
reaches the browser.

**The route guard is a denylist.** Plugin routes are arbitrary first segments, so they
cannot be allow-listed without asking CPA which routes a plugin registered, which CPA does
not report. The denylist is derived from CPA v8.0.15's route table and must be extended
when CPA adds a management root; a plugin cannot shadow a core route, since CPA resolves
its own routes first. Plugin route responses are the plugin's own and are passed through
unprojected for that reason, as the plugin settings document already is.

**Re-basing is textual.** A page that assembles a CPA-root path from fragments at run time
is caught by the request shim, not by the rewrite; a page that navigates the top window or
opens a WebSocket to a CPA-root path is not re-based.

## Consequences

Plugin pages appear in the navigation's Plugins group and in the plugin's settings drawer. The parity
matrix marks plugin pages covered; plugin quota (`/plugins/:id/quota`) remains planned.
