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

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		attempts: make(map[string]*loginAttempt),
	}
}

func (l *loginLimiter) isLocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	att, exists := l.attempts[ip]
	if !exists {
		return false
	}
	return time.Now().Before(att.lockUntil)
}

func (l *loginLimiter) recordFailure(ip string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()

	// prune old records if map grows large
	if len(l.attempts) > 5000 {
		for k, v := range l.attempts {
			if now.After(v.lockUntil) && now.Sub(v.lastFailure) > 15*time.Minute {
				delete(l.attempts, k)
			}
		}
	}

	att, exists := l.attempts[ip]
	if !exists {
		att = &loginAttempt{}
		l.attempts[ip] = att
	}
	att.failures++
	att.lastFailure = now

	var lockDuration time.Duration
	if att.failures >= 8 {
		lockDuration = 60 * time.Second
	} else if att.failures == 7 {
		lockDuration = 30 * time.Second
	} else if att.failures == 6 {
		lockDuration = 15 * time.Second
	} else if att.failures >= 5 {
		lockDuration = 5 * time.Second
	}
	if lockDuration > 0 {
		att.lockUntil = now.Add(lockDuration)
	}
	return lockDuration
}

func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}

// resolveClientIP resolves the client's network IP, respecting reverse proxy headers
// only when the direct remote address is a trusted loopback / local proxy address.
func resolveClientIP(request *http.Request) string {
	if request == nil {
		return "127.0.0.1"
	}
	remote := request.RemoteAddr
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}

	// Only trust forwarded headers if incoming connection is from local proxy
	if host == "127.0.0.1" || host == "::1" || host == "localhost" {
		if fwd := request.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			if len(parts) > 0 {
				client := strings.TrimSpace(parts[0])
				if client != "" {
					return client
				}
			}
		}
		if realIP := strings.TrimSpace(request.Header.Get("X-Real-IP")); realIP != "" {
			return realIP
		}
	}
	return host
}
