package backup

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/lib/oauthutil"
	"golang.org/x/oauth2"
)

var ErrOAuth = errors.New("cloud authorization is invalid or expired")

const oauthLifetime = 15 * time.Minute

type OAuthStart struct {
	Provider     string
	ClientID     string
	ClientSecret string
	RedirectURL  string
}
type OAuthConnection struct {
	ID               string
	AuthorizationURL string
	ExpiresAtMS      int64
	Status           string
}
type oauthConnection struct {
	OAuthConnection
	provider     string
	state        string
	verifier     string
	config       *oauth2.Config
	options      map[string]string
	isExchanging bool
}
type oauthConnections struct {
	mutex    sync.Mutex
	sessions map[string]*oauthConnection
	config   func(context.Context, OAuthStart) (*oauth2.Config, error)
	drive    func(context.Context, *oauth2.Config, *oauth2.Token) (string, string, error)
}

// Obtain the registered application's identity from the pinned backend rather
// than copying its credentials into OMC. OMC owns the browser exchange, not the
// rclone CLI configurator or its local callback listener.
func providerOAuthConfig(ctx context.Context, input OAuthStart) (*oauth2.Config, error) {
	if input.Provider != "drive" && input.Provider != "onedrive" {
		return nil, ErrDestinationConfig
	}
	info, err := fs.Find(input.Provider)
	if err != nil {
		return nil, ErrDestinationConfig
	}
	values := configmap.Simple{}
	for _, option := range info.Options {
		values[option.Name] = option.String()
	}
	mapper := configmap.New().AddGetter(values, configmap.PriorityNormal).AddSetter(values)
	state := ""
	if input.Provider == "drive" {
		state = "oauth"
	}
	out, err := info.Config(ctx, "omc-backup-authorization", mapper, fs.ConfigIn{State: state})
	if err != nil || out == nil {
		return nil, ErrDestinationConfig
	}
	options, ok := out.OAuth.(*oauthutil.Options)
	if !ok || options.OAuth2Config == nil {
		return nil, ErrDestinationConfig
	}
	config := options.OAuth2Config.MakeOauth2Config()
	if input.Provider == "drive" {
		config.Scopes = []string{"https://www.googleapis.com/auth/drive.file"}
	} else {
		config.Scopes = []string{"Files.ReadWrite", "offline_access"}
	}
	if input.ClientID != "" {
		config.ClientID = input.ClientID
		config.ClientSecret = input.ClientSecret
	}
	if input.RedirectURL != "" {
		if input.ClientID == "" {
			return nil, ErrDestinationConfig
		}
		config.RedirectURL = input.RedirectURL
	}
	return config, nil
}

func (m *Manager) StartOAuth(ctx context.Context, input OAuthStart) (OAuthConnection, error) {
	if len(input.ClientID) > 1024 || len(input.ClientSecret) > 4096 {
		return OAuthConnection{}, ErrDestinationConfig
	}
	factory := m.oauth.config
	if factory == nil {
		factory = providerOAuthConfig
	}
	config, err := factory(ctx, input)
	if err != nil {
		return OAuthConnection{}, err
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return OAuthConnection{}, err
	}
	state := base64.RawURLEncoding.EncodeToString(random)
	id := newID()
	if err := m.audit(ctx, "authorization.start", id, "admitted"); err != nil {
		return OAuthConnection{}, err
	}
	options := map[string]string{"client_id": input.ClientID, "client_secret": input.ClientSecret}
	if input.Provider == "drive" {
		options["scope"] = "drive.file"
	}
	verifier := oauth2.GenerateVerifier()
	prompt := "consent"
	if input.Provider == "onedrive" {
		prompt = "select_account"
	}
	view := OAuthConnection{ID: id, AuthorizationURL: config.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("prompt", prompt)), ExpiresAtMS: time.Now().Add(oauthLifetime).UnixMilli(), Status: "waiting"}
	m.oauth.mutex.Lock()
	defer m.oauth.mutex.Unlock()
	if m.oauth.sessions == nil {
		m.oauth.sessions = map[string]*oauthConnection{}
	}
	for key, value := range m.oauth.sessions {
		if value.ExpiresAtMS < time.Now().UnixMilli() {
			delete(m.oauth.sessions, key)
		}
	}
	if len(m.oauth.sessions) >= 8 {
		return OAuthConnection{}, ErrBusy
	}
	m.oauth.sessions[id] = &oauthConnection{OAuthConnection: view, provider: input.Provider, state: state, verifier: verifier, config: config, options: options}
	return view, nil
}
func (m *Manager) OAuthStatus(id string) (OAuthConnection, error) {
	m.oauth.mutex.Lock()
	defer m.oauth.mutex.Unlock()
	value := m.oauth.sessions[id]
	if value == nil || value.ExpiresAtMS < time.Now().UnixMilli() {
		delete(m.oauth.sessions, id)
		return OAuthConnection{}, ErrOAuth
	}
	view := value.OAuthConnection
	view.AuthorizationURL = ""
	return view, nil
}
func (m *Manager) CancelOAuth(id string) {
	m.oauth.mutex.Lock()
	delete(m.oauth.sessions, id)
	m.oauth.mutex.Unlock()
}

// A shared application's registered loopback URL cannot be changed to a remote
// OMC host. Accept only the matching redirect and state, never arbitrary pasted
// URLs, tokens or a request to fetch the pasted address.
func (m *Manager) CompleteOAuth(ctx context.Context, id, callback string) (resultErr error) {
	parsed, err := url.Parse(callback)
	if err != nil || len(callback) > 16<<10 || parsed.User != nil {
		return ErrOAuth
	}
	m.oauth.mutex.Lock()
	value := m.oauth.sessions[id]
	if value == nil || value.ExpiresAtMS < time.Now().UnixMilli() || value.Status != "waiting" {
		m.oauth.mutex.Unlock()
		return ErrOAuth
	}
	expected, err := url.Parse(value.config.RedirectURL)
	if err != nil || parsed.Scheme != expected.Scheme || !strings.EqualFold(parsed.Host, expected.Host) || parsed.Path != expected.Path || parsed.Query().Get("state") != value.state {
		m.oauth.mutex.Unlock()
		return ErrOAuth
	}
	if value.isExchanging {
		m.oauth.mutex.Unlock()
		return ErrBusy
	}
	if parsed.Query().Get("error") != "" {
		value.Status = "denied"
		m.oauth.mutex.Unlock()
		return ErrOAuth
	}
	code := parsed.Query().Get("code")
	if code == "" {
		m.oauth.mutex.Unlock()
		return ErrOAuth
	}
	value.isExchanging = true
	m.oauth.mutex.Unlock()
	defer func() {
		m.oauth.mutex.Lock()
		defer m.oauth.mutex.Unlock()
		value.isExchanging = false
		if resultErr != nil {
			value.Status = "denied"
		}
	}()
	if err := m.audit(ctx, "authorization.complete", id, "admitted"); err != nil {
		return err
	}
	client, _ := ctx.Value(oauth2.HTTPClient).(*http.Client)
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second, Transport: m.options.OutboundTransport}
	}
	exchangeContext := context.WithValue(ctx, oauth2.HTTPClient, client)
	token, err := value.config.Exchange(exchangeContext, code, oauth2.VerifierOption(value.verifier))
	if err != nil || token == nil || token.AccessToken == "" || token.RefreshToken == "" {
		return ErrOAuth
	}
	options := maps.Clone(value.options)
	encoded, err := json.Marshal(token)
	if err != nil {
		return ErrOAuth
	}
	options["token"] = string(encoded)
	if value.provider == "onedrive" {
		lookup := m.oauth.drive
		if lookup == nil {
			lookup = lookupOneDrive
		}
		driveID, driveType, err := lookup(exchangeContext, value.config, token)
		if err != nil {
			return ErrOAuth
		}
		options["drive_id"], options["drive_type"] = driveID, driveType
	}
	m.oauth.mutex.Lock()
	defer m.oauth.mutex.Unlock()
	if m.oauth.sessions[id] != value {
		return ErrOAuth
	}
	value.options = options
	value.Status = "connected"
	return nil
}
func lookupOneDrive(ctx context.Context, config *oauth2.Config, token *oauth2.Token) (string, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType", nil)
	if err != nil {
		return "", "", err
	}
	response, err := config.Client(ctx, token).Do(request)
	if err != nil {
		return "", "", ErrOAuth
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", "", ErrOAuth
	}
	var drive struct {
		ID   string `json:"id"`
		Type string `json:"driveType"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&drive) != nil || drive.ID == "" || (drive.Type != "personal" && drive.Type != "business" && drive.Type != "documentLibrary") {
		return "", "", ErrOAuth
	}
	return drive.ID, drive.Type, nil
}
func (m *Manager) OAuthCallback(ctx context.Context, state, code, providerError string) error {
	m.oauth.mutex.Lock()
	id, callback := "", ""
	for key, value := range m.oauth.sessions {
		if value.state == state {
			id, callback = key, value.config.RedirectURL
			break
		}
	}
	m.oauth.mutex.Unlock()
	if id == "" {
		return ErrOAuth
	}
	parsed, err := url.Parse(callback)
	if err != nil {
		return ErrOAuth
	}
	values := url.Values{"state": {state}, "code": {code}, "error": {providerError}}
	parsed.RawQuery = values.Encode()
	return m.CompleteOAuth(ctx, id, parsed.String())
}
func (m *Manager) oauthOptions(id, provider string) (map[string]string, error) {
	m.oauth.mutex.Lock()
	defer m.oauth.mutex.Unlock()
	value := m.oauth.sessions[id]
	if value == nil || value.ExpiresAtMS < time.Now().UnixMilli() || value.Status != "connected" || value.provider != provider {
		return nil, ErrOAuth
	}
	return maps.Clone(value.options), nil
}
