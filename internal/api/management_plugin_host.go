package api

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

/**
 * The plugin host: what lets a page a plugin registers run inside the console.
 *
 * A plugin page is a document CPA serves under `/v0/resource/plugins/<id>/`, and its
 * script calls the management routes that plugin registered under `/v0/management/`
 * with the CPA management key. The browser of this console holds no such key and may
 * not reach CPA at all, so both halves are served from here, under the console's own
 * session: the document is read without a key, and a plugin route is called with the
 * key added in this process. A route CPA itself owns is refused, so the host reaches
 * plugin routes only and never the unmasked management documents (ADR 0060).
 *
 * The document is written for CPA's root, so its absolute references to those two
 * prefixes are re-based onto this host, in the text it ships and at run time.
 */

// PLUGIN_HOST_ROUTE is the host's mount point below `/api/v1`.
const PLUGIN_HOST_ROUTE = "/plugin-host"

// pluginHostResponseHeaders are the headers of a plugin's answer the browser needs.
// Everything else stays behind, `Set-Cookie` in particular: a plugin must not be able
// to plant a cookie on the console's origin.
var pluginHostResponseHeaders = []string{
	"Content-Type", "Cache-Control", "Content-Disposition", "Content-Language",
	"ETag", "Last-Modified", "Expires", "Retry-After",
}

// pluginHostRequestHeaders are the headers of the page's request a plugin may need.
// The console's cookie and any key the page attached are not among them.
var pluginHostRequestHeaders = []string{"Accept", "Accept-Language", "Content-Type", "If-None-Match", "If-Modified-Since"}

// pluginHostReference finds an absolute reference to one of CPA's two plugin prefixes.
// A reference that continues a longer path or a full URL is left alone, so one that
// already points at this host, or at another origin, is not re-based twice.
var pluginHostReference = regexp.MustCompile(`(^|[^A-Za-z0-9_.:/\\-])(/v0/(?:resource/plugins|management)/)`)

var (
	htmlHeadOpen    = regexp.MustCompile(`(?i)<head(\s[^>]*)?>`)
	htmlRootOpen    = regexp.MustCompile(`(?i)<html(\s[^>]*)?>`)
	htmlDoctypeOpen = regexp.MustCompile(`(?i)^\s*<!doctype[^>]*>`)
)

func (h *Handler) pluginHostPrefix() string {
	return joinURLPath(h.cfg.BasePath, "/api/v1"+PLUGIN_HOST_ROUTE)
}

// pluginHostTarget is the CPA path a host request names: what follows the mount point.
func (h *Handler) pluginHostTarget(request *http.Request) string {
	return strings.TrimPrefix(request.URL.Path, h.pluginHostPrefix())
}

func forwardedPluginHeaders(request *http.Request) http.Header {
	header := http.Header{}
	for _, name := range pluginHostRequestHeaders {
		if value := request.Header.Get(name); value != "" {
			header.Set(name, value)
		}
	}
	return header
}

// rebasePluginReferences points a text body's absolute plugin references at the host.
func rebasePluginReferences(body []byte, hostPrefix string) []byte {
	return pluginHostReference.ReplaceAll(body, []byte("${1}"+hostPrefix+"${2}"))
}

// pluginHostShim re-bases the requests a page builds at run time, which no rewrite of
// its text can see. It runs before the page's own scripts.
func pluginHostShim(hostPrefix string) []byte {
	return []byte(`<script>(function(){var P=` + mustJSON(hostPrefix) + `,R=/^\/v0\/(?:resource\/plugins|management)\//;` +
		`function m(u){try{var x=new URL(u,location.href);if(x.origin===location.origin&&R.test(x.pathname)){x.pathname=P+x.pathname;return x.href}}catch(e){}return u}` +
		`var f=window.fetch;if(f)window.fetch=function(i,o){if(typeof i==="string"||i instanceof URL)i=m(String(i));else if(i&&i.url){var n=m(i.url);if(n!==i.url)i=new Request(n,i)}return f.call(this,i,o)};` +
		`var X=window.XMLHttpRequest;if(X){var p=X.prototype.open;X.prototype.open=function(){if(arguments.length>1)arguments[1]=m(String(arguments[1]));return p.apply(this,arguments)}}` +
		`var E=window.EventSource;if(E){window.EventSource=function(u,c){return new E(m(String(u)),c)};window.EventSource.prototype=E.prototype}` +
		`})();</script>`)
}

// hostPluginDocument re-bases an HTML document and installs the run-time shim as the
// first thing in it that can run.
func hostPluginDocument(body []byte, hostPrefix string) []byte {
	body = rebasePluginReferences(body, hostPrefix)
	shim := pluginHostShim(hostPrefix)
	for _, anchor := range []*regexp.Regexp{htmlHeadOpen, htmlRootOpen, htmlDoctypeOpen} {
		if location := anchor.FindIndex(body); location != nil {
			result := make([]byte, 0, len(body)+len(shim))
			result = append(result, body[:location[1]]...)
			result = append(result, shim...)
			return append(result, body[location[1]:]...)
		}
	}
	return append(shim, body...)
}

func pluginHostMediaType(header http.Header) string {
	mediaType, _, err := mime.ParseMediaType(header.Get("Content-Type"))
	if err != nil {
		return ""
	}
	return strings.ToLower(mediaType)
}

func isRebasedPluginText(mediaType string) bool {
	switch mediaType {
	case "text/css", "text/javascript", "application/javascript", "application/x-javascript":
		return true
	}
	return false
}

func (h *Handler) writePluginHostResponse(writer http.ResponseWriter, response management.PluginHostResponse, body []byte) {
	for _, name := range pluginHostResponseHeaders {
		if value := response.Header.Get(name); value != "" {
			writer.Header().Set(name, value)
		}
	}
	if location := response.Header.Get("Location"); location != "" {
		writer.Header().Set("Location", string(rebasePluginReferences([]byte(location), h.pluginHostPrefix())))
	}
	if writer.Header().Get("Cache-Control") == "" {
		writer.Header().Set("Cache-Control", "no-store")
	}
	writer.WriteHeader(response.StatusCode)
	_, _ = writer.Write(body)
}

func writePluginHostError(writer http.ResponseWriter, err error) {
	if errors.Is(err, management.ErrPluginHostPath) {
		writeError(writer, http.StatusNotFound, "not a plugin resource or plugin route")
		return
	}
	writeCPAFacadeError(writer, err)
}

// servePluginResource serves one resource of a plugin page: the document itself, or
// a stylesheet, script or image it loads.
func (h *Handler) servePluginResource(writer http.ResponseWriter, request *http.Request) {
	resourcePath, _, ok := management.PluginResourcePath(h.pluginHostTarget(request))
	if !ok {
		writeError(writer, http.StatusNotFound, "not a plugin resource")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	response, err := client.PluginResource(request.Context(), resourcePath, request.URL.RawQuery, forwardedPluginHeaders(request))
	if err != nil {
		writePluginHostError(writer, err)
		return
	}
	body := response.Body
	switch mediaType := pluginHostMediaType(response.Header); {
	case mediaType == "text/html":
		body = hostPluginDocument(body, h.pluginHostPrefix())
	case isRebasedPluginText(mediaType):
		body = rebasePluginReferences(body, h.pluginHostPrefix())
	}
	h.writePluginHostResponse(writer, response, body)
}

// servePluginRoute calls one management route a plugin registered, for that plugin's
// page. The key is added here; whatever key the page attached is dropped.
func (h *Handler) servePluginRoute(writer http.ResponseWriter, request *http.Request) {
	routePath, ok := management.PluginRoutePath(h.pluginHostTarget(request))
	if !ok {
		writeError(writer, http.StatusNotFound, "not a plugin route")
		return
	}
	var body []byte
	if request.Body != nil && request.Method != http.MethodGet && request.Method != http.MethodHead {
		data, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, management.PLUGIN_HOST_BODY_LIMIT))
		if err != nil {
			// Only an overflow is the body's size; a dropped connection is not.
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(writer, http.StatusRequestEntityTooLarge, "request body is too large")
			} else {
				writeError(writer, http.StatusBadRequest, "invalid request body")
			}
			return
		}
		body = data
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	// A read is the page drawing itself; anything else changes plugin state on the
	// operator's behalf and is recorded like every other write the console makes.
	isWrite := request.Method != http.MethodGet && request.Method != http.MethodHead
	target := security.RedactText(routePath)
	if isWrite {
		if auditErr := h.recordAudit(request, "plugin.route_call", "plugin_route", target, "attempt", map[string]any{"method": request.Method}); auditErr != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; plugin request aborted")
			return
		}
	}
	response, err := client.PluginRoute(request.Context(), request.Method, routePath, request.URL.RawQuery, forwardedPluginHeaders(request), body)
	if err != nil {
		if isWrite {
			_ = h.recordAudit(request, "plugin.route_call", "plugin_route", target, "failure", map[string]any{"method": request.Method, "error": err.Error()})
		}
		writePluginHostError(writer, err)
		return
	}
	if isWrite {
		result := "success"
		if response.StatusCode >= http.StatusBadRequest {
			result = "failure"
		}
		_ = h.recordAudit(request, "plugin.route_call", "plugin_route", target, result, map[string]any{"method": request.Method, "status": response.StatusCode})
	}
	h.writePluginHostResponse(writer, response, response.Body)
}
