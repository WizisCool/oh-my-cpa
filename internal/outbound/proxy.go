// Package outbound applies the deployment's proxy policy to OMC-owned external requests.
package outbound

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"golang.org/x/net/http/httpproxy"
)

const (
	ModeEnvironment = "environment"
	ModeDirect      = "direct"
	ModeProxy       = "proxy"
)

// Validate refuses invalid or ambiguous proxy URLs without returning their contents.
func Validate(settings repository.OutboundProxySettings) error {
	switch settings.Mode {
	case ModeEnvironment, ModeDirect:
		if settings.URL != "" || settings.NoProxy != "" {
			return errors.New("proxy address and exclusions require proxy mode")
		}
		return nil
	case ModeProxy:
	default:
		return errors.New("invalid outbound proxy mode")
	}
	if len(settings.URL) > 2048 || len(settings.NoProxy) > 4096 {
		return errors.New("outbound proxy settings are too long")
	}
	proxy, err := url.Parse(strings.TrimSpace(settings.URL))
	if err != nil || proxy.Hostname() == "" || proxy.Opaque != "" || proxy.RawQuery != "" || proxy.Fragment != "" || (proxy.Path != "" && proxy.Path != "/") {
		return errors.New("invalid outbound proxy address")
	}
	if strings.Contains(settings.URL, security.RedactedValue) {
		return errors.New("re-enter proxy authentication")
	}
	if proxy.User != nil {
		password, _ := proxy.User.Password()
		if strings.Contains(proxy.User.Username(), security.RedactedValue) || strings.Contains(password, security.RedactedValue) {
			return errors.New("re-enter proxy authentication")
		}
	}
	if port := proxy.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return errors.New("invalid outbound proxy port")
		}
	}
	switch proxy.Scheme {
	case "http", "https", "socks5", "socks5h":
		return nil
	default:
		return errors.New("unsupported outbound proxy protocol")
	}
}

// isExplicitLoopbackExclusion handles loopback separately because httpproxy always
// bypasses localhost even when an operator explicitly selected a proxy.
func isExplicitLoopbackExclusion(target *url.URL, exclusions string) bool {
	host := strings.ToLower(target.Hostname())
	ip := net.ParseIP(host)
	for _, item := range strings.Split(exclusions, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if item == "*" {
			return true
		}
		if _, network, err := net.ParseCIDR(item); err == nil && ip != nil && network.Contains(ip) {
			return true
		}
		entryHost, port, err := net.SplitHostPort(item)
		if err != nil {
			entryHost = item
		} else if port != target.Port() {
			continue
		}
		entryHost = strings.Trim(entryHost, "[]")
		if entryHost == host || (strings.HasPrefix(entryHost, ".") && strings.HasSuffix(host, entryHost)) {
			return true
		}
	}
	return false
}

// NewTransport creates a dedicated transport. Each request reads the current policy,
// so changes apply without mutating the process-wide transport or internal connections.
func NewTransport(store repository.OutboundProxyStore) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(request *http.Request) (*url.URL, error) {
		settings, _, err := store.Load(request.Context())
		if err != nil || Validate(settings) != nil {
			return nil, errors.New("outbound proxy settings unavailable")
		}
		switch settings.Mode {
		case ModeEnvironment:
			return http.ProxyFromEnvironment(request)
		case ModeDirect:
			return nil, nil
		default:
			host := request.URL.Hostname()
			ip := net.ParseIP(host)
			if strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback()) {
				if isExplicitLoopbackExclusion(request.URL, settings.NoProxy) {
					return nil, nil
				}
				return url.Parse(settings.URL)
			}
			proxyForURL := (&httpproxy.Config{HTTPProxy: settings.URL, HTTPSProxy: settings.URL, NoProxy: settings.NoProxy}).ProxyFunc()
			proxy, err := proxyForURL(request.URL)
			if err != nil {
				return nil, errors.New("outbound proxy configuration is invalid")
			}
			return proxy, nil
		}
	}
	return transport
}
