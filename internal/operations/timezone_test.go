package operations

import (
	"context"
	"encoding/json"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"path/filepath"
	"strings"
	"testing"
)

func TestTimezoneCapabilitiesUseValidatedPreference(t *testing.T) {
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "timezone.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := repository.New(database)
	registry := capability.NewRegistry()
	if err := (&Service{Repo: repo}).registerTimezone(registry); err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New(strings.Repeat("t", 32))
	if err != nil {
		t.Fatal(err)
	}
	executor := &capability.Executor{Registry: registry, Store: repository.AgentStore{Repo: repo, Cipher: cipher}}
	for _, adapter := range []string{"agent", "mcp"} {
		principal := capability.Principal{ID: "administrator", Adapter: adapter, IsAdmin: true}
		result, err := executor.Invoke(ctx, principal, "timezone_set", json.RawMessage(`{"timezone":"Asia/Kathmandu"}`), "")
		if err != nil || result.Status != "success" {
			t.Fatalf("%+v %v", result, err)
		}
		result, err = executor.Invoke(ctx, principal, "timezone_get", json.RawMessage(`{}`), "")
		var info repository.TimezoneInfo
		if err != nil || result.Status != "success" || json.Unmarshal(result.Data, &info) != nil || info.EffectiveTimezone != "Asia/Kathmandu" {
			t.Fatalf("%+v %v", result, err)
		}
		result, err = executor.Invoke(ctx, principal, "timezone_set", json.RawMessage(`{"timezone":"Invalid/Zone"}`), "")
		if err != nil || result.Status != "error" || result.Code != "invalid_timezone" {
			t.Fatalf("%+v %v", result, err)
		}
	}
}
