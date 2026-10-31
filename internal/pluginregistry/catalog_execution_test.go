package pluginregistry_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pluginregistry"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (transport releaseTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func releaseDocument(version, digest string) map[string]any {
	assets := []map[string]any{}
	for _, platform := range []string{"darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64", "windows_amd64", "windows_arm64"} {
		name := "omc-zcode-oauth_" + version + "_" + platform + ".zip"
		assets = append(assets, map[string]any{"name": name, "size": 1024, "digest": "sha256:" + digest, "state": "uploaded", "browser_download_url": "https://github.com/WizisCool/omc-zcode-oauth/releases/download/v" + version + "/" + name})
	}
	return map[string]any{"id": 123, "tag_name": "v" + version, "draft": false, "prerelease": false, "assets": assets}
}

func TestCatalogFollowsOfficialStableReleasesAndKeepsImmutableHistory(t *testing.T) {
	ctx := context.Background()
	db, err := repository.Open(ctx, fmt.Sprintf("file:builtin_releases_%d?mode=memory&cache=shared", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)
	document := releaseDocument("0.1.4", strings.Repeat("a", 64))
	status := http.StatusOK
	original := http.DefaultTransport
	http.DefaultTransport = releaseTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "https://api.github.com/repos/WizisCool/omc-zcode-oauth/releases/latest" {
			return nil, fmt.Errorf("unexpected release target: %s", request.URL)
		}
		if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Fatal("credentials sent to a public release endpoint")
		}
		raw, _ := json.Marshal(document)
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw))), Request: request}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = original })
	store := &failingCatalogStore{Repository: repo}
	catalog := pluginregistry.NewCatalog(store)
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatalf("initial official release: %v", err)
	}
	document = releaseDocument("0.1.5", strings.Repeat("b", 64))
	if err := catalog.Refresh(ctx); err != nil {
		t.Fatalf("new stable release requires no OMC metadata edit: %v", err)
	}
	if state := catalog.State(); state.Status != "ready" || state.Manifest.Plugins[0].Version != "0.1.5" {
		t.Fatalf("latest stable release = %+v", state)
	}
	store.fail = true
	document = releaseDocument("0.1.6", strings.Repeat("c", 64))
	if err := catalog.Refresh(ctx); err == nil || catalog.State().Manifest.Plugins[0].Version != "0.1.5" {
		t.Fatal("an unpersisted release replaced the executable snapshot")
	}
	store.fail = false
	reloaded := pluginregistry.NewCatalog(repo)
	if err := reloaded.Load(ctx); err != nil {
		t.Fatal(err)
	}
	historical, err := reloaded.Registry("omc-zcode-oauth", "0.1.4")
	if err != nil || !strings.Contains(string(historical), strings.Repeat("a", 64)) {
		t.Fatalf("historical artifact identity lost: %s %v", historical, err)
	}
	for _, failure := range []string{"draft", "prerelease", "tag", "digest", "origin", "incomplete", "duplicate", "transport", "downgrade", "replacement"} {
		t.Run(failure, func(t *testing.T) {
			document = releaseDocument("0.1.5", strings.Repeat("b", 64))
			status = http.StatusOK
			assets := document["assets"].([]map[string]any)
			switch failure {
			case "draft", "prerelease":
				document[failure] = true
			case "tag":
				document["tag_name"] = "v0.1.6-rc.1"
			case "digest":
				assets[0]["digest"] = ""
			case "origin":
				assets[0]["browser_download_url"] = "https://other.example/plugin.zip"
			case "incomplete":
				document["assets"] = assets[:1]
			case "duplicate":
				document["assets"] = append(assets, assets[0])
			case "transport":
				status = http.StatusServiceUnavailable
			case "downgrade":
				document = releaseDocument("0.1.4", strings.Repeat("a", 64))
			case "replacement":
				document = releaseDocument("0.1.5", strings.Repeat("c", 64))
			}
			if err := reloaded.Refresh(ctx); err == nil {
				t.Fatal("invalid release was accepted")
			}
			if state := reloaded.State(); state.Status != "ready" || state.Manifest.Plugins[0].Version != "0.1.5" {
				t.Fatalf("failed refresh replaced the readonly snapshot: %+v", state)
			}
		})
	}
	snapshot, _, err := repo.LoadBuiltinCatalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, changed := range []string{
		strings.Replace(string(snapshot), `"id":"omc-zcode-oauth"`, `"id":"community-plugin"`, 1),
		strings.Replace(string(snapshot), `"repository":"https://github.com/WizisCool/omc-zcode-oauth"`, `"repository":"https://github.com/other/plugin"`, 1),
	} {
		if err := reloaded.Accept(ctx, []byte(changed)); err == nil {
			t.Fatal("a foreign publisher became a managed builtin")
		}
	}
}

func TestDescriptionRejectsIdentityMarkupLocaleAndSize(t *testing.T) {
	valid := `{"schema_version":1,"plugin_id":"omc-zcode-oauth","plugin_version":"0.1.4","i18n":{"description":{"zh":"描述","en":"Description","zh-Hant":"描述","ms":"Huraian"}}}`
	for name, raw := range map[string]string{"valid": valid, "wrong version": strings.Replace(valid, "0.1.4", "0.1.3", 1), "wrong id": strings.Replace(valid, "omc-zcode-oauth", "other", 1), "markup": strings.Replace(valid, "Description", "<script>", 1), "unknown locale": strings.Replace(valid, `"ms"`, `"de"`, 1), "oversized": strings.Repeat("x", pluginregistry.MaxDescriptionBytes+1)} {
		t.Run(name, func(t *testing.T) {
			descriptions, err := pluginregistry.ParseDescription([]byte(raw), "omc-zcode-oauth", "0.1.4")
			if name == "valid" {
				if err != nil || len(descriptions) != 4 {
					t.Fatalf("description = %v %v", descriptions, err)
				}
			} else if err == nil {
				t.Fatal("invalid description accepted")
			}
		})
	}
}

// Persistence must succeed before a newly discovered version becomes executable.
type failingCatalogStore struct {
	*repository.Repository
	fail bool
}

func (store *failingCatalogStore) SaveBuiltinCatalog(ctx context.Context, raw []byte, manifest pluginregistry.Manifest) error {
	if store.fail {
		return errors.New("synthetic snapshot write failed")
	}
	return store.Repository.SaveBuiltinCatalog(ctx, raw, manifest)
}
