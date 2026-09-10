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
	sessionVersion = "v2"
)

// ErrKeyRequired is returned when no CPA management key is configured. The
// application still starts so the UI can explain that CPA must be configured
// before anybody can sign in.
var ErrKeyRequired = errors.New("CPA management key is required")

// Manager implements a stateless, single-admin session whose only login
// credential is the CPA management key. Oh My CPA has no separate admin
// password: entering the management key in the UI is exactly how the bundled
// CPA panel works. The key never leaves the server process; the browser only
// receives an HMAC-signed, expiring cookie.
//
// The signing secret is derived from the management key, so rotating the key
// in CPA immediately invalidates every previously issued session.
type Manager struct {
	secret     []byte
	cookiePath string
	isSecure   bool
	now        func() time.Time
}

// New builds a session manager for the given CPA management key. The key must
// be non-empty, but its strength policy belongs to CPA, not here: keys like
// "admin" remain valid local credentials.
func New(managementKey, basePath, publicURL string) (*Manager, error) {
	managementKey = strings.TrimSpace(managementKey)
	if managementKey == "" {
		return nil, ErrKeyRequired
	}
	// HMAC-SHA256 over a fixed label: a dedicated signing secret without a
	// second configured value.
	mac := hmac.New(sha256.New, []byte(managementKey))
	mac.Write([]byte("oh-my-cpa session signing secret v2"))
	derived := mac.Sum(nil)
	return &Manager{
		secret:     derived,
		cookiePath: cookiePath(basePath),
		isSecure:   isHTTPS(publicURL),
		now:        time.Now,
	}, nil
}

// KeyMatches reports whether the provided password is the CPA management key.
func (m *Manager) KeyMatches(key string) bool {
	if m == nil {
		return false
	}
	provided := hmac.New(sha256.New, []byte(strings.TrimSpace(key)))
	provided.Write([]byte("oh-my-cpa session signing secret v2"))
	return subtle.ConstantTimeCompare(provided.Sum(nil), m.secret) == 1
}

func (m *Manager) Issue(w http.ResponseWriter) error {
	if m == nil || len(m.secret) < 32 {
		return ErrKeyRequired
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
		SameSite: http.SameSiteStrictMode,
		Secure:   m.isSecure,
		Expires:  now.Add(12 * time.Hour),
	})
	w.Header().Add("Cache-Control", "no-store")
	return nil
}

func (m *Manager) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     m.cookiePath,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   m.isSecure,
		Expires:  time.Unix(0, 0),
	})
	w.Header().Add("Cache-Control", "no-store")
}

func (m *Manager) Valid(request *http.Request) bool {
	if m == nil || len(m.secret) < 32 || request == nil {
		return false
	}
	cookie, err := request.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 4 || parts[0] != sessionVersion {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(signature) != sha256.Size {
		return false
	}
	payload := parts[0] + "." + parts[1] + "." + parts[2]
	if !verifyHMAC(m.secret, payload, signature) {
		return false
	}
	expires, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || m.now().UTC().Unix() >= expires {
		return false
	}
	return true
}

func (m *Manager) sign(payload string) []byte {
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func verifyHMAC(secret []byte, payload string, signature []byte) bool {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return subtle.ConstantTimeCompare(mac.Sum(nil), signature) == 1
}

func cookiePath(basePath string) string {
	basePath = strings.TrimSpace(basePath)
	if basePath == "" {
		return "/"
	}
	if !strings.HasPrefix(basePath, "/") {
		basePath = "/" + basePath
	}
	return strings.TrimRight(basePath, "/") + "/"
}

func isHTTPS(publicURL string) bool {
	if strings.TrimSpace(publicURL) == "" {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(publicURL))
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "https")
}
