package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManagerIssuesAndValidatesScopedSession(t *testing.T) {
	manager, err := New("cpa-management-key", "/omc", "https://example.test/omc")
	if err != nil {
		t.Fatal(err)
	}
	if !manager.KeyMatches("cpa-management-key") || manager.KeyMatches("wrong") {
		t.Fatal("management key matching failed")
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
	request.AddCookie(&http.Cookie{Name: CookieName, Value: "v2.invalid.invalid.invalid"})
	if manager.Valid(request) {
		t.Fatal("invalid cookie was accepted")
	}
}

func TestManagerAcceptsShortCpaKeys(t *testing.T) {
	// CPA owns the strength policy for its management key; short keys such as
	// "admin" are legitimate local credentials and must still work.
	manager, err := New("admin", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	if !manager.KeyMatches("admin") || manager.KeyMatches("Admin") || manager.KeyMatches("") {
		t.Fatal("short key matching failed")
	}
	response := httptest.NewRecorder()
	if err := manager.Issue(response); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://example.test/omc/", nil)
	request.AddCookie(response.Result().Cookies()[0])
	if !manager.Valid(request) {
		t.Fatal("session issued for a short key was not valid")
	}
}

func TestManagerRejectsEmptyConfiguration(t *testing.T) {
	if _, err := New("", "/omc", ""); err == nil {
		t.Fatal("empty management key unexpectedly accepted")
	}
	if _, err := New("   ", "/omc", ""); err == nil {
		t.Fatal("blank management key unexpectedly accepted")
	}
}

func TestManagerExpiry(t *testing.T) {
	manager, err := New("cpa-management-key", "/omc", "")
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
	if !manager.Valid(request) {
		t.Fatal("fresh cookie was not valid")
	}
	manager.now = func() time.Time { return current.Add(13 * time.Hour) }
	if manager.Valid(request) {
		t.Fatal("expired cookie was accepted")
	}
}

func TestManagerRotationInvalidatesSessions(t *testing.T) {
	old, err := New("old-cpa-key", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	if err := old.Issue(response); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://example.test/omc/", nil)
	request.AddCookie(response.Result().Cookies()[0])

	rotated, err := New("new-cpa-key", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Valid(request) {
		t.Fatal("session survived a management key rotation")
	}
	if rotated.KeyMatches("old-cpa-key") {
		t.Fatal("rotated manager accepted the previous key")
	}
}
