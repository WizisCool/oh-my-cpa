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

	// Bound the map so a distributed credential-stuffing run cannot grow it
	// without limit.
	if len(l.attempts) > 5000 {
		for k, v := range l.attempts {
			if now.After(v.lockUntil) && now.Sub(v.lastFailure) > 15*time.Minute {
				delete(l.attempts, k)
			}
		}
	}

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
