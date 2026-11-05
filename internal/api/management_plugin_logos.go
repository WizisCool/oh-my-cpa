package api

import (
	"encoding/base64"
	"net/url"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// Inline artwork is part of the plugin-list response; remote artwork is loaded by
// the browser, so a server without an egress route can still present plugin branding.
const maxPluginLogoBytes = 512 * 1024

var renderableLogoMediaTypes = map[string]bool{
	"image/svg+xml":            true,
	"image/png":                true,
	"image/jpeg":               true,
	"image/gif":                true,
	"image/webp":               true,
	"image/avif":               true,
	"image/x-icon":             true,
	"image/vnd.microsoft.icon": true,
}

// projectPluginLogo accepts self-contained artwork or a publisher's absolute HTTP(S)
// URL. Credentials and relative paths are not part of the image-source contract.
func projectPluginLogo(logo string) string {
	logo = strings.TrimSpace(logo)
	if inline := projectInlinePluginLogo(logo); inline != "" {
		return inline
	}
	if httpURLOrEmpty(logo) == "" {
		return ""
	}
	parsed, _ := url.Parse(logo)
	if parsed.Hostname() == "" || parsed.User != nil {
		return ""
	}
	return logo
}

// The public demo uses only self-contained plugin artwork.
func projectInlinePluginLogo(logo string) string {
	logo = strings.TrimSpace(logo)
	if _, ok := inlineImageMediaType(logo); !ok {
		return ""
	}
	return logo
}

// pluginLogoURL prefers the installed entry's artwork over registration metadata.
func pluginLogoURL(plugin management.PluginItem) string {
	candidate := strings.TrimSpace(plugin.Logo)
	if candidate == "" && plugin.Metadata != nil {
		candidate = strings.TrimSpace(plugin.Metadata.Logo)
	}
	return projectPluginLogo(candidate)
}

// inlineImageMediaType bounds the image payload, not its encoded representation.
func inlineImageMediaType(raw string) (string, bool) {
	rest, found := strings.CutPrefix(raw, "data:")
	if !found {
		return "", false
	}
	header, payload, found := strings.Cut(rest, ",")
	if !found || len(payload) == 0 {
		return "", false
	}
	isBase64 := strings.HasSuffix(strings.ToLower(strings.TrimSpace(header)), ";base64")
	if !isBase64 && len(payload) > maxPluginLogoBytes {
		return "", false
	}
	if isBase64 && base64DecodedLen(payload) > maxPluginLogoBytes {
		return "", false
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(header, ";", 2)[0]))
	if !renderableLogoMediaTypes[mediaType] {
		return "", false
	}
	return mediaType, true
}

// DecodedLen rounds up to whole groups without subtracting padding.
func base64DecodedLen(payload string) int {
	padding := 0
	switch {
	case strings.HasSuffix(payload, "=="):
		padding = 2
	case strings.HasSuffix(payload, "="):
		padding = 1
	}
	return base64.StdEncoding.DecodedLen(len(payload)) - padding
}
