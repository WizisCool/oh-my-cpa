package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
}

type loginAttempt struct {
	failures    int
	lastFailure time.Time
	lockUntil   time.Time
}

const maxLoginAttempts = 5000

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		attempts: make(map[string]*loginAttempt),
	}
}

func (l *loginLimiter) isLocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	attempt, exists := l.attempts[ip]
	if !exists {
		return false
	}
	return time.Now().Before(attempt.lockUntil)
}

func (l *loginLimiter) recordFailure(ip string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()

	l.makeRoomFor(ip, now)

	attempt, exists := l.attempts[ip]
	if !exists {
		attempt = &loginAttempt{}
		l.attempts[ip] = attempt
	}
	attempt.failures++
	attempt.lastFailure = now

	var lockDuration time.Duration
	if attempt.failures >= 8 {
		lockDuration = 60 * time.Second
	} else if attempt.failures == 7 {
		lockDuration = 30 * time.Second
	} else if attempt.failures == 6 {
		lockDuration = 15 * time.Second
	} else if attempt.failures >= 5 {
		lockDuration = 5 * time.Second
	}
	if lockDuration > 0 {
		attempt.lockUntil = now.Add(lockDuration)
	}
	return lockDuration
}

// makeRoomFor keeps the attempt map hard-bounded. The first pass removes
// entries that are both unlocked and idle; if the map is still full, one
// arbitrary entry is evicted so a new client cannot grow memory without limit.
func (l *loginLimiter) makeRoomFor(ip string, now time.Time) {
	if _, exists := l.attempts[ip]; exists || len(l.attempts) < maxLoginAttempts {
		return
	}
	for key, attempt := range l.attempts {
		if now.After(attempt.lockUntil) && now.Sub(attempt.lastFailure) > 15*time.Minute {
			delete(l.attempts, key)
			if len(l.attempts) < maxLoginAttempts {
				return
			}
		}
	}
	for key := range l.attempts {
		delete(l.attempts, key)
		if len(l.attempts) < maxLoginAttempts {
			return
		}
	}
}

func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}

// resolveClientIP resolves the client's network IP. Forwarding headers are
// considered only when the direct peer belongs to an explicitly configured
// trusted proxy network; the rightmost valid, untrusted entry is the client the
// proxy observed. This keeps an attacker-controlled leftmost X-Forwarded-For
// value from becoming a fresh rate-limit bucket on every request.
func resolveClientIP(request *http.Request, trustedProxies []*net.IPNet) string {
	if request == nil {
		return "127.0.0.1"
	}
	remote := request.RemoteAddr
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	remoteIP := parseForwardedIP(host)
	if remoteIP == nil {
		return host
	}
	if !isTrustedProxyIP(remoteIP, trustedProxies) {
		return remoteIP.String()
	}

	if fwd := request.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.Split(fwd, ",")
		for index := len(parts) - 1; index >= 0; index-- {
			clientIP := parseForwardedIP(parts[index])
			if clientIP == nil || isTrustedProxyIP(clientIP, trustedProxies) {
				continue
			}
			return clientIP.String()
		}
	}
	if realIP := parseForwardedIP(request.Header.Get("X-Real-IP")); realIP != nil && !isTrustedProxyIP(realIP, trustedProxies) {
		return realIP.String()
	}
	return remoteIP.String()
}

func parseForwardedIP(raw string) net.IP {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 128 {
		return nil
	}
	if host, _, err := net.SplitHostPort(raw); err == nil {
		raw = host
	}
	raw = strings.Trim(raw, "[]")
	return net.ParseIP(raw)
}

func isTrustedProxyIP(ip net.IP, trustedProxies []*net.IPNet) bool {
	for _, network := range trustedProxies {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func parseTrustedProxyNetworks(cidrs []string) []*net.IPNet {
	networks := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, network, err := net.ParseCIDR(strings.TrimSpace(cidr))
		if err == nil && network != nil {
			networks = append(networks, network)
		}
	}
	return networks
}
