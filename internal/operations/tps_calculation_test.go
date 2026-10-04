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
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestTpsCalculationCapabilitiesSharePreference(t *testing.T) {
	ctx := context.Background()
	database, err := repository.Open(ctx, filepath.Join(t.TempDir(), "tps.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	repo := repository.New(database)
	registry := capability.NewRegistry()
	if err := (&Service{Repo: repo}).registerTpsCalculation(registry); err != nil {
		t.Fatal(err)
	}
	cipher, err := appcrypto.New(strings.Repeat("t", 32))
	if err != nil {
		t.Fatal(err)
	}
	executor := &capability.Executor{Registry: registry, Store: repository.AgentStore{Repo: repo, Cipher: cipher}}
	for _, adapter := range []string{"agent", "mcp"} {
		t.Run(adapter, func(t *testing.T) {
			if err := repo.PutPreference(ctx, repository.PreferenceTpsCalculationMode, `null`); err != nil {
				t.Fatal(err)
			}
			principal := capability.Principal{ID: "administrator", Adapter: adapter, IsAdmin: true}
			readMode := func(want repository.TpsCalculationMode) {
				t.Helper()
				result, err := executor.Invoke(ctx, principal, "tps_calculation_get", json.RawMessage(`{}`), "")
				var info TpsCalculationInfo
				if err != nil || result.Status != "success" || json.Unmarshal(result.Data, &info) != nil || info.Mode != want {
					t.Fatalf("read: %+v err=%v", result, err)
				}
			}
			for _, raw := range []string{`null`, `"future_mode"`, `{}`, `true`} {
				if err := repo.PutPreference(ctx, repository.PreferenceTpsCalculationMode, raw); err != nil {
					t.Fatal(err)
				}
				readMode(repository.TpsExcludeTTFT)
			}
			for _, mode := range []repository.TpsCalculationMode{repository.TpsIncludeTTFT, repository.TpsExcludeTTFT} {
				input, _ := json.Marshal(TpsCalculationInfo{Mode: mode})
				result, err := executor.Invoke(ctx, principal, "tps_calculation_set", input, "")
				var info TpsCalculationInfo
				if err != nil || result.Status != "success" || !slices.Contains(result.Invalidates, "preferences") || json.Unmarshal(result.Data, &info) != nil || info.Mode != mode {
					t.Fatalf("write: %+v err=%v", result, err)
				}
				stored, isStored, err := repo.GetPreference(ctx, repository.PreferenceTpsCalculationMode)
				if err != nil || !isStored || stored != `"`+string(mode)+`"` {
					t.Fatalf("stored=%s found=%t err=%v", stored, isStored, err)
				}
				readMode(mode)
			}
			for _, input := range []string{`{"mode":"unknown"}`, `{"mode":""}`, `{}`} {
				result, err := executor.Invoke(ctx, principal, "tps_calculation_set", json.RawMessage(input), "")
				if err != nil || result.Status != "error" || result.Code != "invalid_parameters" {
					t.Fatalf("invalid: %+v err=%v", result, err)
				}
				readMode(repository.TpsExcludeTTFT)
			}
			principal.IsAdmin = false
			for _, name := range []string{"tps_calculation_get", "tps_calculation_set"} {
				result, err := executor.Invoke(ctx, principal, name, json.RawMessage(`{"mode":"include_ttft"}`), "")
				if err == nil || err.Error() != "capability_forbidden" {
					t.Fatalf("unauthorized: %+v err=%v", result, err)
				}
			}
		})
	}
}
