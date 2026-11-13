package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestIdentityDirectoryLifecycleAcrossToggleDisableAndDeletion(t *testing.T) {
	const (
		rawProviderKey = "test-provider-key-aaaaaaaaaaaa-alpha"
		rawOAuthEmail  = "architect.operator@example.org"
		rawOAuthToken  = "test-oauth-token-aaaaaaaaaaaa"
	)

	var mu sync.Mutex
	oaiDisabled := false
	oaiDeleted := false
	oaiAuthGen := 1
	authFileDeleted := false
	pluginDeleted := false

	fakeCPA := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		path := request.URL.Path

		switch {
		case request.Method == http.MethodGet && path == "/v0/management/openai-compatibility":
			if oaiDeleted {
				_, _ = writer.Write([]byte(`{"openai-compatibility":[]}`))
				return
			}
			// Real CPA omits auth-index on disabled OpenAI-compatible entries and
			// assigns a fresh runtime index when re-enabled.
			authIdxField := ""
			if !oaiDisabled {
				idx := "idx-inception-v1"
				if oaiAuthGen > 1 {
					idx = "idx-inception-v2"
				}
				authIdxField = `,"auth-index":"` + idx + `"`
			}
			disabledStr := "false"
			if oaiDisabled {
				disabledStr = "true"
			}
			_, _ = writer.Write([]byte(`{"openai-compatibility":[{"name":"inception","base-url":"https://proxyuser:proxypass@api.inceptionlabs.ai/v1?secret_param=1","disabled":` + disabledStr + `,"api-key-entries":[{"api-key":"` + rawProviderKey + `"` + authIdxField + `}]}]}`))

		case request.Method == http.MethodGet && path == "/v8/management/config/api-keys/openai-compatibility":
			if oaiDeleted {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"error":"not_found"}`))
				return
			}
			disabledStr := "false"
			if oaiDisabled {
				disabledStr = "true"
			}
			_, _ = writer.Write([]byte(`[{"name":"inception","base-url":"https://proxyuser:proxypass@api.inceptionlabs.ai/v1?secret_param=1","disabled":` + disabledStr + `,"keys":[{"api-key":"` + rawProviderKey + `"}]}]`))

		case request.Method == http.MethodDelete && path == "/v8/management/config/api-keys/openai-compatibility":
			oaiDeleted = true
			_, _ = writer.Write([]byte(`{"status":"ok"}`))

		case request.Method == http.MethodPatch && path == "/v8/management/config":
			var merge struct {
				APIKeys map[string][]map[string]any `json:"api-keys"`
			}
			_ = json.NewDecoder(request.Body).Decode(&merge)
			if groups, ok := merge.APIKeys["openai-compatibility"]; ok {
				if len(groups) == 0 {
					oaiDeleted = true
				} else {
					wasDisabled := oaiDisabled
					isDis, _ := groups[0]["disabled"].(bool)
					oaiDisabled = isDis
					if wasDisabled && !oaiDisabled {
						oaiAuthGen++
					}
				}
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))

		case request.Method == http.MethodGet && (path == "/v8/management/config.yaml" || path == "/v0/management/config.yaml"):
			_, _ = writer.Write([]byte("config-version: 8\n"))

		case request.Method == http.MethodGet && path == "/v8/management/config":
			_, _ = writer.Write([]byte(`{"config-version":8}`))

		case request.Method == http.MethodGet && strings.HasPrefix(path, "/v8/management/credentials"):
			if authFileDeleted {
				_, _ = writer.Write([]byte(`{"files":[]}`))
				return
			}
			_, _ = writer.Write([]byte(`{"files":[{
				"id":"codex-seat.json",
				"name":"codex-` + rawOAuthEmail + `.json",
				"auth_index":"aaaa1111bbbb2222",
				"type":"oauth",
				"provider":"qoder",
				"oauth_provider":"qoder-cn",
				"email":"` + rawOAuthEmail + `",
				"token":"` + rawOAuthToken + `",
				"status":"ready"
			}]}`))

		case request.Method == http.MethodDelete && strings.HasPrefix(path, "/v8/management/credentials"):
			authFileDeleted = true
			_, _ = writer.Write([]byte(`{"status":"ok","deleted":1,"files":["codex-` + rawOAuthEmail + `.json"]}`))

		case request.Method == http.MethodGet && (path == "/v0/management/plugins" || path == "/v8/management/plugins"):
			if pluginDeleted {
				_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins":[]}`))
				return
			}
			_, _ = writer.Write([]byte(`{"plugins_enabled":true,"plugins":[{
				"id":"omc-qoder-oauth",
				"enabled":true,
				"effective_enabled":true,
				"supports_oauth":true,
				"oauth_providers":["qoder","qoder-cn"],
				"logo":"data:image/svg+xml,%3Csvg%20id%3D%22qoder%22/%3E",
				"metadata":{"name":"Qoder"},
				"oauth_provider_entries":[
					{"identifier":"qoder","name":"Qoder Global"},
					{"identifier":"qoder-cn","name":"Qoder CN","logo":"data:image/svg+xml,%3Csvg%20id%3D%22qoder-cn%22/%3E"}
				]
			}]}`))

		case request.Method == http.MethodDelete && (strings.HasPrefix(path, "/v0/management/plugins/") || strings.HasPrefix(path, "/v8/management/plugins/")):
			pluginDeleted = true
			_, _ = writer.Write([]byte(`{"file_deleted":true,"configured_removed":true}`))

		default:
			if strings.HasPrefix(path, "/v8/management/config/api-keys/") {
				writer.WriteHeader(http.StatusNotFound)
				_, _ = writer.Write([]byte(`{"error":"not_found"}`))
				return
			}
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(fakeCPA.Close)

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(context.Background(), dashboardMemoryDSN("identity_directory"), repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)
	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 fakeCPA.URL,
		UsageAddr:               strings.TrimPrefix(fakeCPA.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	// Create a custom icon and assign custom display name "Inception" + custom icon to openai-compat-0.
	customIcon, err := repo.CreateCustomIcon(context.Background(), "Inception Mark", "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ii8+PC9zdmc+")
	if err != nil {
		t.Fatal(err)
	}
	customIconRef := "custom:" + customIcon.ID
	if err := repo.PutPreference(context.Background(), repository.PreferenceProviderNames, `{"openai-compat-0":"Inception"}`); err != nil {
		t.Fatal(err)
	}
	if err := repo.PutPreference(context.Background(), repository.PreferenceProviderIcons, `{"openai-compat-0":"`+customIconRef+`"}`); err != nil {
		t.Fatal(err)
	}

	// Seed historical usage events for both the Inception API key and the OAuth credential.
	nowMS := time.Now().UnixMilli()
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{
		{
			InstanceID:  "default",
			EventKey:    "evt-inception-1",
			Provider:    "openai-compatible-inception",
			AuthType:    "apikey",
			AuthIndex:   "idx-inception-v1",
			Model:       "mercury-coder",
			TimestampMS: nowMS - 1000,
			TotalTokens: 120,
		},
		{
			InstanceID:  "default",
			EventKey:    "evt-oauth-1",
			Provider:    "qoder",
			AuthType:    "oauth",
			AuthIndex:   "aaaa1111bbbb2222",
			Model:       "qoder-pro",
			TimestampMS: nowMS - 500,
			TotalTokens: 240,
		},
	}); err != nil {
		t.Fatal(err)
	}

	authManager, err := auth.New("app-admin-secret", "", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{
		BasePath: "/omc",
		Version:  "v0.1.0-test",
		CPA:      config.CPAConfig{BaseURL: fakeCPA.URL, ManagementKey: "app-admin-secret"},
	}, repo, cipher, nil, authManager)
	// Use a 500ms debounce window when testing pre-flush optimistic projection, then
	// flush deterministically via SSE state_sync / coordinator gate with zero sleeps.
	if err := handler.EnableStateCoordinator(context.Background(), StateCoordinatorOptions{
		DebounceWindow: 500 * time.Millisecond,
		MaxBatchWait:   2 * time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handler.CloseStateCoordinator(context.Background()) })

	sseEvents, unsubscribeSSE, subErr := handler.stateCoord.Broker().Subscribe()
	if subErr != nil {
		t.Fatal(subErr)
	}
	t.Cleanup(unsubscribeSSE)
	awaitStateSync := func() statecoord.Event {
		t.Helper()
		for {
			select {
			case ev := <-sseEvents:
				if ev.Type == statecoord.EventStateSync {
					return ev
				}
			case <-time.After(3 * time.Second):
				t.Fatal("timed out waiting for state_sync event")
			}
		}
	}

	server := httptest.NewServer(handler.Router())
	t.Cleanup(server.Close)
	client := signedInClient(t, server.URL+"/omc/api/auth/login", "app-admin-secret")

	readDirectory := func() IdentityDirectoryResponse {
		t.Helper()
		resp, payload := getJSON(t, client, server.URL+"/omc/api/v1/management/identity-directory")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /management/identity-directory = %d: %s", resp.StatusCode, payload)
		}
		for _, secret := range []string{rawProviderKey, rawOAuthToken, "proxyuser", "proxypass", "secret_param"} {
			if strings.Contains(string(payload), secret) {
				t.Fatalf("identity-directory leaked raw secret %q: %s", secret, payload)
			}
		}
		var out IdentityDirectoryResponse
		if err := json.Unmarshal(payload, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// Step 1: Initial live read captures Inception + OAuth credential + Plugin into archive.
	dir1 := readDirectory()
	if len(dir1.Providers) != 1 || dir1.Providers[0].Name != "Inception" || dir1.Providers[0].UpstreamName != "inception" {
		t.Fatalf("unexpected live provider projection: %+v", dir1.Providers)
	}
	if len(dir1.Providers[0].AuthIndexes) != 1 || dir1.Providers[0].AuthIndexes[0] != "idx-inception-v1" {
		t.Fatalf("expected runtime auth_index idx-inception-v1, got %+v", dir1.Providers[0].AuthIndexes)
	}

	// Step 2: Disable Inception via StateCoordinator status toggle.
	// Verify BOTH immediate pre-flush optimistic disabled projection AND post-flush fingerprint recovery!
	toggleOffResp, toggleOffBody := doJSON(t, client, http.MethodPatch,
		server.URL+"/omc/api/v1/management/providers/status",
		`{"family":"openai-compatibility","index":0,"disabled":true,"expected_name":"inception"}`,
	)
	if toggleOffResp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH disable status = %d: %s", toggleOffResp.StatusCode, toggleOffBody)
	}
	dirOptimisticDisabled := readDirectory()
	if !dirOptimisticDisabled.Providers[0].Disabled {
		t.Fatal("expected optimistic pre-flush read to report disabled=true")
	}

	if err := handler.stateCoord.FlushNow(context.Background()); err != nil {
		t.Fatalf("FlushNow disable failed: %v", err)
	}
	_ = awaitStateSync()

	dirDisabled := readDirectory()
	if !dirDisabled.Providers[0].Disabled {
		t.Fatal("expected provider to be disabled after toggle flush")
	}
	if len(dirDisabled.Providers[0].AuthIndexes) != 1 || dirDisabled.Providers[0].AuthIndexes[0] != "idx-inception-v1" {
		t.Fatalf("disabled provider lost recovered auth_index: %+v", dirDisabled.Providers[0].AuthIndexes)
	}

	// Step 3: Re-enable Inception. CPA assigns regenerated idx-inception-v2; StateCoordinator flush
	// refreshes baseline so live provider carries idx-inception-v2 while archive still remembers idx-inception-v1.
	toggleOnResp, toggleOnBody := doJSON(t, client, http.MethodPatch,
		server.URL+"/omc/api/v1/management/providers/status",
		`{"family":"openai-compatibility","index":0,"disabled":false,"expected_name":"inception"}`,
	)
	if toggleOnResp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH enable status = %d: %s", toggleOnResp.StatusCode, toggleOnBody)
	}
	if err := handler.stateCoord.FlushNow(context.Background()); err != nil {
		t.Fatalf("FlushNow enable failed: %v", err)
	}
	syncAfterEnable := awaitStateSync()

	if syncAfterEnable.Version <= 1 {
		t.Fatalf("expected coordinator version to advance after toggle flush, got %d", syncAfterEnable.Version)
	}
	dirReenabled := readDirectory()
	if dirReenabled.Providers[0].Disabled {
		t.Fatal("expected provider to be re-enabled")
	}
	if len(dirReenabled.Providers[0].AuthIndexes) != 1 || dirReenabled.Providers[0].AuthIndexes[0] != "idx-inception-v2" {
		t.Fatalf("expected refreshed runtime auth_index idx-inception-v2, got %+v", dirReenabled.Providers[0].AuthIndexes)
	}

	// Step 4: Delete Inception provider, OAuth credential file, and Qoder plugin.
	delProvResp, delProvBody := doJSON(t, client, http.MethodDelete, server.URL+"/omc/api/v1/management/providers/openai-compat-0", "")
	if delProvResp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE provider = %d: %s", delProvResp.StatusCode, delProvBody)
	}
	delAuthResp, delAuthBody := doJSON(t, client, http.MethodDelete,
		server.URL+"/omc/api/v1/management/auth-files?name=codex-"+rawOAuthEmail+".json", "")
	if delAuthResp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE auth-file = %d: %s", delAuthResp.StatusCode, delAuthBody)
	}
	delPluginResp, delPluginBody := doJSON(t, client, http.MethodDelete,
		server.URL+"/omc/api/v1/management/plugins/omc-qoder-oauth", "")
	if delPluginResp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE plugin = %d: %s", delPluginResp.StatusCode, delPluginBody)
	}

	dirAfterDelete := readDirectory()
	if strings.Contains(mustMarshalString(t, dirAfterDelete.ArchivedCredentials), rawOAuthEmail) {
		t.Fatalf("archived_credentials stored unmasked account email: %+v", dirAfterDelete.ArchivedCredentials)
	}
	if len(dirAfterDelete.Providers) != 0 || len(dirAfterDelete.Credentials) != 0 || len(dirAfterDelete.Plugins) != 0 {
		t.Fatalf("expected empty live catalogs after deletion, got providers=%d creds=%d plugins=%d",
			len(dirAfterDelete.Providers), len(dirAfterDelete.Credentials), len(dirAfterDelete.Plugins))
	}

	// Verify archived Inception provider & credential carry sanitized custom name + custom icon + key mask.
	var foundInceptionProv *repository.ArchivedProvider
	var foundQoderCN *repository.ArchivedProvider
	for i := range dirAfterDelete.ArchivedProviders {
		p := &dirAfterDelete.ArchivedProviders[i]
		if p.ProviderKey == "openai-compatible-inception" {
			foundInceptionProv = p
		}
		if p.ProviderKey == "qoder-cn" {
			foundQoderCN = p
		}
	}
	if foundInceptionProv == nil || foundInceptionProv.Name != "Inception" || foundInceptionProv.IconID != customIconRef {
		t.Fatalf("archived provider missing Inception metadata: %+v", foundInceptionProv)
	}
	if foundQoderCN == nil || foundQoderCN.Name != "Qoder CN" || !foundQoderCN.IsMultiPortal || foundQoderCN.Logo == "" {
		t.Fatalf("archived plugin portal missing Qoder CN metadata: %+v", foundQoderCN)
	}

	var foundOAuthCred, foundKeyCred *repository.ArchivedCredential
	for i := range dirAfterDelete.ArchivedCredentials {
		c := &dirAfterDelete.ArchivedCredentials[i]
		if c.AuthIndex == "aaaa1111bbbb2222" {
			foundOAuthCred = c
		}
		if c.AuthIndex == "idx-inception-v1" {
			foundKeyCred = c
		}
	}
	expectedMaskedEmail := security.MaskAccount(rawOAuthEmail)
	if foundOAuthCred == nil || foundOAuthCred.MaskedAccount != expectedMaskedEmail || foundOAuthCred.OAuthProvider != "qoder-cn" {
		t.Fatalf("archived OAuth credential missing masked account or portal: %+v (want %q)", foundOAuthCred, expectedMaskedEmail)
	}
	expectedKeyMask := security.MaskSecret(rawProviderKey)
	if foundKeyCred == nil || foundKeyCred.ProviderName != "Inception" || foundKeyCred.KeyMask != expectedKeyMask || foundKeyCred.IconID != customIconRef {
		t.Fatalf("archived API key credential missing metadata: %+v", foundKeyCred)
	}

	// Usage events endpoint still resolves key mask for historical idx-inception-v1 after provider deletion!
	evResp, evPayload := getJSON(t, client, server.URL+"/omc/api/v1/usage/events?limit=20")
	if evResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /usage/events = %d: %s", evResp.StatusCode, evPayload)
	}
	if !strings.Contains(string(evPayload), expectedKeyMask) {
		t.Fatalf("expected historical usage event to retain masked key %q after deletion: %s", expectedKeyMask, evPayload)
	}

	// Drain SSE events emitted by provider/auth-file/plugin deletions, then verify
	// that deleting a custom icon advances state version via Notify.
	preIconEnv, err := handler.stateCoord.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for len(sseEvents) > 0 {
		<-sseEvents
	}

	// Step 5: Delete the custom icon from the library — archived records must clear custom:<id> atomically!
	delIconResp, delIconBody := doJSON(t, client, http.MethodDelete,
		server.URL+"/omc/api/v1/custom-icons/"+customIcon.ID, "")
	if delIconResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE custom icon = %d: %s", delIconResp.StatusCode, delIconBody)
	}
	iconSync := awaitStateSync()
	if iconSync.Version <= preIconEnv.Version {
		t.Fatalf("expected custom icon delete Notify to advance version (%d -> %d)", preIconEnv.Version, iconSync.Version)
	}

	// Verify stored SQLite columns directly: base_url must have stripped userinfo and query parameters.
	var storedProvURL, storedCredURL string
	if err := repo.SQL().QueryRow(`SELECT base_url FROM archived_providers WHERE provider_key = 'openai-compatible-inception'`).Scan(&storedProvURL); err != nil {
		t.Fatal(err)
	}
	if err := repo.SQL().QueryRow(`SELECT base_url FROM archived_credentials WHERE auth_index = 'idx-inception-v1'`).Scan(&storedCredURL); err != nil {
		t.Fatal(err)
	}
	if storedProvURL != "https://api.inceptionlabs.ai/v1" || storedCredURL != "https://api.inceptionlabs.ai/v1" {
		t.Fatalf("archived base_url was not sanitized before persistence: prov=%q cred=%q", storedProvURL, storedCredURL)
	}

	dirAfterIconDelete := readDirectory()
	for _, p := range dirAfterIconDelete.ArchivedProviders {
		if p.ProviderKey == "openai-compatible-inception" && p.IconID != "" {
			t.Fatalf("deleted custom icon was not cleared from archived_providers: %+v", p)
		}
	}
	for _, c := range dirAfterIconDelete.ArchivedCredentials {
		if c.AuthIndex == "idx-inception-v1" && c.IconID != "" {
			t.Fatalf("deleted custom icon was not cleared from archived_credentials: %+v", c)
		}
	}
}

func TestProviderDeletionArchiveRefusalAndNamespaceIsolation(t *testing.T) {
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	db, err := repository.Open(context.Background(), dashboardMemoryDSN("identity_archive_refusal"), repository.WithCipher(cipher))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.New(db)

	cpa := newFakeCPA(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && (r.URL.Path == "/v0/management/config.yaml" || r.URL.Path == "/v8/management/config.yaml"):
			_, _ = w.Write([]byte("config-version: 8\n"))
		case r.Method == http.MethodGet && r.URL.Path == "/v8/management/config":
			_, _ = w.Write([]byte(`{"config-version":8}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v0/management/openai-compatibility":
			_, _ = w.Write([]byte(`{"openai-compatibility":[{"name":"relay","base-url":"https://relay.test/v1","api-key-entries":[{"api-key":"dummy-key-alpha-beta","auth-index":"idx-relay"}]}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v8/management/config/api-keys/openai-compatibility":
			_, _ = w.Write([]byte(`[{"name":"relay","base-url":"https://relay.test/v1","keys":[{"api-key":"dummy-key-alpha-beta"}]}]`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v0/management/"):
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v8/management/config/api-keys/"):
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(cpa.Close)

	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Test CPA",
		BaseURL:                 cpa.URL,
		UsageAddr:               strings.TrimPrefix(cpa.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	// 1. Cross-namespace collision on archived_credentials tombstones rather than blending fields.
	if err := repo.UpsertArchivedCredentials(context.Background(), "default", []repository.ArchivedCredential{{
		AuthIndex:      "shared-idx",
		Kind:           "oauth",
		ProviderKey:    "codex",
		ProviderFamily: "codex",
		DisplayName:    "Seat One",
		MaskedAccount:  "al•••e@acme.test",
	}}); err != nil {
		t.Fatal(err)
	}
	largeLogo := "data:image/svg+xml," + strings.Repeat("a", 12_000)
	if err := repo.UpsertArchivedProviders(context.Background(), "default", []repository.ArchivedProvider{{
		ProviderKey: "qoder-cn",
		Kind:        "oauth_plugin",
		Name:        "Qoder CN",
		Logo:        largeLogo,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpsertArchivedCredentials(context.Background(), "default", []repository.ArchivedCredential{{
		AuthIndex:      "shared-idx",
		Kind:           "apikey",
		ProviderKey:    "openai-compatible-relay",
		ProviderFamily: "openai-compatibility",
		ProviderName:   "Relay",
		KeyMask:        "test-key••••••••1111",
	}}); err != nil {
		t.Fatal(err)
	}

	// Quota snapshot for another gateway must not synthesize a phantom archived credential on "default".
	_, _ = repo.SQL().Exec(`INSERT INTO quota_snapshots (provider, auth_index, account, status, observed_at_ms) VALUES ('claude', 'foreign-idx', '', 'ok', 1000)`)

	creds, provs, err := repo.ListIdentityArchive(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range creds {
		if c.AuthIndex == "foreign-idx" {
			t.Fatalf("quota-only snapshot without instance ownership leaked into ListIdentityArchive: %+v", c)
		}
		if c.AuthIndex == "shared-idx" {
			if !c.IsAmbiguous || c.DisplayName != "" || c.MaskedAccount != "" || c.ProviderName != "" || c.KeyMask != "" {
				t.Fatalf("expected cross-namespace auth_index collision to tombstone fields: %+v", c)
			}
		}
	}
	if len(provs) != 1 || provs[0].Logo != largeLogo {
		t.Fatalf("expected 12KB inline SVG logo to survive archive storage intact, got len=%d", len(provs))
	}

	// 2. Provider deletion returns stable localized refusal code when archive persistence fails.
	authManager, err := auth.New("app-admin-secret", "", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{
		BasePath: "/omc",
		Version:  "v0.1.0-test",
		CPA:      config.CPAConfig{BaseURL: cpa.URL, ManagementKey: "app-admin-secret"},
	}, repo, cipher, nil, authManager)
	server := httptest.NewServer(handler.Router())
	t.Cleanup(server.Close)
	client := signedInClient(t, server.URL+"/omc/api/auth/login", "app-admin-secret")

	if _, err := repo.SQL().Exec(`DROP TABLE archived_providers`); err != nil {
		t.Fatal(err)
	}

	delResp, delBody := doJSON(t, client, http.MethodDelete, server.URL+"/omc/api/v1/management/providers/openai-compat-0", "")
	if delResp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 when archive persistence fails before delete, got %d: %s", delResp.StatusCode, delBody)
	}
	var errPayload map[string]string
	if err := json.Unmarshal([]byte(delBody), &errPayload); err != nil {
		t.Fatalf("decode error payload: %v (%s)", err, delBody)
	}
	if errPayload["code"] != providerArchiveFailedCode {
		t.Fatalf("expected code %q, got %+v", providerArchiveFailedCode, errPayload)
	}
}

func mustMarshalString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
