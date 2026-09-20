package api

import (
	"fmt"
	"net/http"
	"testing"
)

func TestResolveClientIPRequiresTrustedProxy(t *testing.T) {
	request := &http.Request{
		RemoteAddr: "10.0.0.5:1234",
		Header:     http.Header{"X-Forwarded-For": []string{"198.51.100.1, 203.0.113.7"}},
	}

	if got := resolveClientIP(request, nil); got != "10.0.0.5" {
		t.Fatalf("untrusted proxy header was accepted: %q", got)
	}

	trusted := parseTrustedProxyNetworks([]string{"10.0.0.0/8"})
	if got := resolveClientIP(request, trusted); got != "203.0.113.7" {
		t.Fatalf("rightmost client IP = %q, want 203.0.113.7", got)
	}

	request.Header.Set("X-Forwarded-For", "198.51.100.1, 10.0.0.9")
	if got := resolveClientIP(request, trusted); got != "198.51.100.1" {
		t.Fatalf("rightmost untrusted client IP = %q, want 198.51.100.1", got)
	}

	request.Header.Set("X-Forwarded-For", "not-an-ip")
	if got := resolveClientIP(request, trusted); got != "10.0.0.5" {
		t.Fatalf("invalid forwarded IP should fall back to the peer: %q", got)
	}
}

func TestLoginLimiterKeepsAttemptMapBounded(t *testing.T) {
	limiter := newLoginLimiter()
	for index := 0; index < maxLoginAttempts+25; index++ {
		limiter.recordFailure(fmt.Sprintf("198.51.%d.%d", index/250, index%250))
	}
	if len(limiter.attempts) > maxLoginAttempts {
		t.Fatalf("attempt map grew to %d, cap is %d", len(limiter.attempts), maxLoginAttempts)
	}
}
