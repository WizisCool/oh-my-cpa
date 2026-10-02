package operations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestCustomIconCapabilitiesAcrossAdapters(t *testing.T) {
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "icons.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := repository.New(database)
	registry := capability.NewRegistry()
	if err := (&Service{Repo: repo}).registerCustomIcons(registry); err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New(strings.Repeat("t", 32))
	if err != nil {
		t.Fatal(err)
	}
	executor := &capability.Executor{Registry: registry, Store: repository.AgentStore{Repo: repo, Cipher: cipher}, Authorize: func(_ context.Context, id, _ string) bool { return id == "administrator" }}
	imageData := base64.StdEncoding.EncodeToString([]byte(`<svg><circle r="10"/></svg>`))
	for _, adapter := range []string{"agent", "mcp"} {
		principal := capability.Principal{ID: "administrator", Adapter: adapter, IsAdmin: true}
		arguments, _ := json.Marshal(map[string]string{"name": "Team", "data": imageData})
		result, err := executor.Invoke(ctx, principal, "custom_icon_create", arguments, "")
		if err != nil || result.Status != "success" {
			t.Fatalf("%+v %v", result, err)
		}
		if strings.Contains(string(result.Data), imageData) {
			t.Fatal("artwork leaked")
		}
		var icon repository.CustomIcon
		if err := json.Unmarshal(result.Data, &icon); err != nil {
			t.Fatal(err)
		}
		target, _ := json.Marshal(map[string]string{"id": icon.ID})
		result, err = executor.Invoke(ctx, principal, "custom_icons_list", json.RawMessage(`{}`), "")
		if err != nil || result.Status != "success" || !strings.Contains(string(result.Data), icon.ID) {
			t.Fatalf("%+v %v", result, err)
		}
		if err := repo.PutPreference(ctx, repository.PreferenceProviderIcons, `{"provider":"custom:`+icon.ID+`"}`); err != nil {
			t.Fatal(err)
		}
		result, err = executor.Invoke(ctx, principal, "custom_icon_delete", target, "")
		if err != nil || result.Status != "pending" {
			t.Fatalf("%+v %v", result, err)
		}
		if _, err := repo.GetCustomIcon(ctx, icon.ID); err != nil {
			t.Fatal("deleted before confirmation")
		}
		pending, err := executor.Get(ctx, principal, result.OperationID)
		previewJSON, _ := json.Marshal(pending.Preview)
		if err != nil || !strings.Contains(string(previewJSON), "restore_defaults") || !strings.Contains(string(previewJSON), `"reference_count":"1"`) {
			t.Fatalf("approval must explain assignment removal: %s %v", previewJSON, err)
		}
		operation, err := executor.Decide(ctx, capability.Principal{ID: "administrator", Adapter: "agent", IsAdmin: true}, result.OperationID, true, "")
		if err != nil || operation.Result.Status != "success" {
			t.Fatalf("%+v %v", operation, err)
		}
		raw, _, err := repo.GetPreference(ctx, repository.PreferenceProviderIcons)
		if err != nil || raw != `{}` {
			t.Fatalf("approved deletion left an override: %s %v", raw, err)
		}
		forbidden := capability.Principal{ID: "limited", Adapter: adapter}
		result, err = executor.Invoke(ctx, forbidden, "custom_icons_list", json.RawMessage(`{}`), "")
		if err == nil || err.Error() != "capability_forbidden" {
			t.Fatalf("%+v %v", result, err)
		}
	}
}
