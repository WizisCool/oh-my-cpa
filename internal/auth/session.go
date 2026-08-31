package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	CookieName     = "omc_session"
	sessionVersion = "v1"
)

var ErrInvalidConfiguration = errors.New("admin password and session secret are required")

// Manager implements a stateless, single-admin session. The browser receives
// only an HMAC-signed, expiring cookie; the configured password and signing
// secret never leave the server process.
type Manager struct {
	passwordDigest [sha256.Size]byte
	secret         []byte
	cookiePath     string
	secure         bool
	now            func() time.Time
}

func New(adminPassword, sessionSecret, basePath, publicURL string) (*Manager, error) {
	adminPassword = strings.TrimSpace(adminPassword)
	sessionSecret = strings.TrimSpace(sessionSecret)
	if len([]byte(adminPassword)) < 12 || len([]byte(sessionSecret)) < 32 {
		return nil, ErrInvalidConfiguration
	}
	digest := sha256.Sum256([]byte(adminPassword))
	return &Manager{
		passwordDigest: digest,
		secret:         append([]byte(nil), []byte(sessionSecret)...),
		cookiePath:     cookiePath(basePath),
		secure:         isHTTPS(publicURL),
		now:            time.Now,
	}, nil
}

func (m *Manager) PasswordMatches(password string) bool {
	if m == nil {
		return false
	}
	digest := sha256.Sum256([]byte(password))
	return subtle.ConstantTimeCompare(digest[:], m.passwordDigest[:]) == 1
}

func (m *Manager) Issue(w http.ResponseWriter) error {
	if m == nil || len(m.secret) < 32 {
		return ErrInvalidConfiguration
	}
	now := m.now().UTC()
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("generate session nonce: %w", err)
	}
	payload := strings.Join([]string{
		sessionVersion,
		strconv.FormatInt(now.Add(12*time.Hour).Unix(), 10),
		base64.RawURLEncoding.EncodeToString(nonce),
	}, ".")
	signature := m.sign(payload)
	value := payload + "." + base64.RawURLEncoding.EncodeToString(signature)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     m.cookiePath,
		HttpOnly: true,
		Secure:   m.secure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int((12 * time.Hour).Seconds()),
		Expires:  now.Add(12 * time.Hour),
	})
	return nil
}

func (m *Manager) Clear(w http.ResponseWriter) {
	if m == nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     m.cookiePath,
		HttpOnly: true,
		Secure:   m.secure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0).UTC(),
	})
}

func (m *Manager) Valid(r *http.Request) bool {
	if m == nil || r == nil {
		return false
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 4 || parts[0] != sessionVersion {
		return false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || expires <= m.now().Unix() {
		return false
	}
	payload := strings.Join(parts[:3], ".")
	provided, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	expected := m.sign(payload)
	return subtle.ConstantTimeCompare(provided, expected) == 1
}

func (m *Manager) sign(payload string) []byte {
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func cookiePath(basePath string) string {
	basePath = strings.TrimSpace(basePath)
	if basePath == "" || basePath == "/" {
		return "/"
	}
	return "/" + strings.Trim(strings.TrimSpace(basePath), "/") + "/"
}

func isHTTPS(publicURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(publicURL))
	return err == nil && strings.EqualFold(parsed.Scheme, "https")
}
