package operations

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestQuotaAutoRefreshCapabilitiesSharePreference(t *testing.T) {
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "auto-refresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := repository.New(database)
	registry := capability.NewRegistry()
	if err := (&Service{Repo: repo}).registerQuotaAutoRefresh(registry); err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New(strings.Repeat("q", 32))
	if err != nil {
		t.Fatal(err)
	}
	executor := &capability.Executor{Registry: registry, Store: repository.AgentStore{Repo: repo, Cipher: cipher}}
	for _, adapter := range []string{"agent", "mcp"} {
		t.Run(adapter, func(t *testing.T) {
			if _, err := repo.SQL().ExecContext(ctx, `DELETE FROM ui_preferences WHERE pref_key = ?`, repository.PreferenceQuotaAutoRefresh); err != nil {
				t.Fatal(err)
			}
			principal := capability.Principal{ID: "administrator", Adapter: adapter, IsAdmin: true}
			readSettings := func(want quota.AutoRefreshSettings) {
				t.Helper()
				result, err := executor.Invoke(ctx, principal, "quota_auto_refresh_get", json.RawMessage(`{}`), "")
				var settings quota.AutoRefreshSettings
				if err != nil || result.Status != "success" || json.Unmarshal(result.Data, &settings) != nil || settings != want {
					t.Fatalf("read: %+v err=%v, want %+v", result, err, want)
				}
			}
			readSettings(quota.DefaultAutoRefreshSettings())

			want := quota.AutoRefreshSettings{IntervalMinutes: 60, IsRefreshOnResetEnabled: false}
			result, err := executor.Invoke(ctx, principal, "quota_auto_refresh_set", json.RawMessage(`{"interval_minutes":60,"refresh_on_reset":false}`), "")
			if err != nil || result.Status != "success" || !slices.Contains(result.Invalidates, "preferences") {
				t.Fatalf("write: %+v err=%v", result, err)
			}
			stored, isStored, err := repo.GetPreference(ctx, repository.PreferenceQuotaAutoRefresh)
			if err != nil || !isStored || stored != `{"interval_minutes":60,"refresh_on_reset":false}` {
				t.Fatalf("stored=%s found=%t err=%v", stored, isStored, err)
			}
			readSettings(want)

			for _, input := range []string{`{}`, `{"interval_minutes":60}`, `{"interval_minutes":2,"refresh_on_reset":true}`, `{"interval_minutes":2000,"refresh_on_reset":true}`} {
				result, err := executor.Invoke(ctx, principal, "quota_auto_refresh_set", json.RawMessage(input), "")
				if err != nil || result.Status != "error" || result.Code != "invalid_parameters" {
					t.Fatalf("invalid %s: %+v err=%v", input, result, err)
				}
				readSettings(want)
			}

			principal.IsAdmin = false
			for _, name := range []string{"quota_auto_refresh_get", "quota_auto_refresh_set"} {
				result, err := executor.Invoke(ctx, principal, name, json.RawMessage(`{"interval_minutes":30,"refresh_on_reset":true}`), "")
				if err == nil || err.Error() != "capability_forbidden" {
					t.Fatalf("unauthorized: %+v err=%v", result, err)
				}
			}
		})
	}
}
