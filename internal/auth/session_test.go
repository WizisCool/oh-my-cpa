package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManagerIssuesAndValidatesScopedSession(t *testing.T) {
	manager, err := New("valid-admin-password", "01234567890123456789012345678901", "/omc", "https://example.test/omc")
	if err != nil {
		t.Fatal(err)
	}
	if !manager.PasswordMatches("valid-admin-password") || manager.PasswordMatches("wrong") {
		t.Fatal("password matching failed")
	}
	response := httptest.NewRecorder()
	if err := manager.Issue(response); err != nil {
		t.Fatal(err)
	}
	setCookie := response.Header().Get("Set-Cookie")
	for _, expected := range []string{"Path=/omc/", "HttpOnly", "Secure", "SameSite=Strict"} {
		if !strings.Contains(setCookie, expected) {
			t.Fatalf("session cookie %q does not contain %q", setCookie, expected)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "https://example.test/omc/", nil)
	request.AddCookie(response.Result().Cookies()[0])
	if !manager.Valid(request) {
		t.Fatal("issued cookie was not valid")
	}
	request = httptest.NewRequest(http.MethodGet, "https://example.test/omc/", nil)
	request.AddCookie(&http.Cookie{Name: CookieName, Value: "v1.invalid.invalid.invalid"})
	if manager.Valid(request) {
		t.Fatal("invalid cookie was accepted")
	}
}

func TestManagerRejectsMissingConfiguration(t *testing.T) {
	if _, err := New("short", "01234567890123456789012345678901", "/omc", ""); err == nil {
		t.Fatal("short password unexpectedly accepted")
	}
	if _, err := New("valid-admin-password", "short", "/omc", ""); err == nil {
		t.Fatal("short session secret unexpectedly accepted")
	}
}

func TestManagerExpiry(t *testing.T) {
	manager, err := New("valid-admin-password", "01234567890123456789012345678901", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	current := time.Now().UTC()
	manager.now = func() time.Time { return current }
	response := httptest.NewRecorder()
	if err := manager.Issue(response); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://example.test/omc/", nil)
	request.AddCookie(response.Result().Cookies()[0])
	manager.now = func() time.Time { return current.Add(13 * time.Hour) }
	if manager.Valid(request) {
		t.Fatal("expired session was accepted")
	}
}
