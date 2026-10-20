package management

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMoveProviderFamilyKeepsUnrelatedStoredGroupsAndUsesOneGuardedWrite(t *testing.T) {
	const sourceJSON = `[
	 {"name":"hidden","base-url":"https://hidden.test","keys":[{"api-key":"unusable-key","operator-setting":true}]},
	 {"name":"team","base-url":"https://relay.test","priority":3,"keys":[{"api-key":"first"},{"api-key":"moved","weight":2},{"api-key":"last"}]}
	]`
	const targetJSON = `[{"name":"codex-1","base-url":"https://dest.test","keys":[{"api-key":"dest","websockets":true}]}]`
	const storedYAML = "config-version: 8\n# exact operator document\n"
	before := decodeGroups(t, sourceJSON)
	targetBefore := decodeGroups(t, targetJSON)
	var written map[string][]map[string]any
	writes := 0
	backup := &recordingBackup{}
	server := newV8Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /v0/management/config.yaml":
			_, _ = w.Write([]byte(storedYAML))
		case "GET /v8/management/config/api-keys/claude":
			_, _ = w.Write([]byte(sourceJSON))
		case "GET /v8/management/config/api-keys/codex":
			_, _ = w.Write([]byte(targetJSON))
		case "GET /v0/management/claude-api-key":
			_, _ = w.Write([]byte(`{"claude-api-key":[{"api-key":"first","base-url":"https://relay.test"},{"api-key":"moved","base-url":"https://relay.test","auth-index":"move-index"},{"api-key":"last","base-url":"https://relay.test"}]}`))
		case "GET /v0/management/codex-api-key":
			_, _ = w.Write([]byte(`{"codex-api-key":[{"api-key":"dest","base-url":"https://dest.test"}]}`))
		case "PATCH /v8/management/config":
			writes++
			if len(backup.documents) != 1 || backup.documents[0] != storedYAML {
				t.Error("write did not retain the exact pre-move backup")
			}
			if r.Header.Get("If-Match") != storedConfigVersion(storedYAML) {
				t.Error("move did not guard the read/modify/write snapshot")
			}
			var merge struct {
				APIKeys map[string][]map[string]any `json:"api-keys"`
			}
			if err := json.NewDecoder(r.Body).Decode(&merge); err != nil {
				t.Error(err)
			}
			written = merge.APIKeys
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "fixture-management", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	client.WithConfigBackup(backup)
	start, count, err := client.MoveProviderFamily(context.Background(), "claude", "codex", 1, func(source ProviderFamilyEntry) (ProviderFamilyEntry, error) {
		if source.Keys[0].APIKey != "moved" || source.Keys[0].AuthIndex != "move-index" || *source.Keys[0].Priority != 3 {
			t.Error("wrong stored/runtime source identity")
		}
		return ProviderFamilyEntry{Keys: []ConfigAPIKey{{APIKey: source.Keys[0].APIKey, BaseURL: "https://relay.test"}}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if start != 1 || count != 1 || writes != 1 || len(written) != 2 {
		t.Fatal("move was not one two-family patch")
	}
	wantSource := decodeGroups(t, sourceJSON)
	wantSource[1]["keys"] = []any{wantSource[1]["keys"].([]any)[0], wantSource[1]["keys"].([]any)[2]}
	if !reflect.DeepEqual(written["claude"], wantSource) || !reflect.DeepEqual(written["codex"][0], targetBefore[0]) {
		t.Fatal("move changed unrelated stored settings")
	}
	if written["codex"][1]["name"] == "codex-1" {
		t.Fatal("destination group name collided")
	}
	if !reflect.DeepEqual(before[0], written["claude"][0]) {
		t.Fatal("runtime-hidden source group was lost")
	}
}

func TestMoveProviderFamilyRefusesAHiddenSourceDuplicate(t *testing.T) {
	gateway := &groupsGateway{
		family:  "claude",
		stored:  `[{"name":"team","base-url":"https://relay.test","keys":[{"api-key":"duplicate"},{"api-key":"duplicate"}]}]`,
		runtime: `{"claude-api-key":[{"api-key":"duplicate","base-url":"https://relay.test"}]}`,
	}
	client := newGroupsClient(t, gateway)
	_, _, err := client.MoveProviderFamily(context.Background(), "claude", "codex", 0,
		func(source ProviderFamilyEntry) (ProviderFamilyEntry, error) {
			t.Fatal("ambiguous source reached conversion")
			return source, nil
		})
	if !errors.Is(err, ErrProviderSourceConflict) {
		t.Fatalf("duplicate source = %v", err)
	}
	if gateway.written != nil || gateway.removed {
		t.Fatal("a source duplicate activated while moving its visible twin")
	}
}

func TestMoveProviderFamilyBackupFailureAndRevisionConflict(t *testing.T) {
	for _, failBackup := range []bool{true, false} {
		t.Run(map[bool]string{true: "backup", false: "revision"}[failBackup], func(t *testing.T) {
			writes := 0
			backup := &recordingBackup{}
			if failBackup {
				backup.err = errors.New("storage unavailable")
			}
			server := newV8Server(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/v0/management/config.yaml":
					_, _ = w.Write([]byte("config-version: 8\n"))
				case strings.HasPrefix(r.URL.Path, "/v8/management/config/api-keys/"):
					_, _ = w.Write([]byte(`[{"name":"entry","base-url":"https://relay.test","keys":[{"api-key":"move-key"}]}]`))
				case r.URL.Path == "/v0/management/claude-api-key":
					_, _ = w.Write([]byte(`{"claude-api-key":[{"api-key":"move-key","base-url":"https://relay.test"}]}`))
				case r.URL.Path == "/v0/management/codex-api-key":
					_, _ = w.Write([]byte(`{"codex-api-key":[]}`))
				case r.Method == http.MethodPatch:
					writes++
					w.WriteHeader(http.StatusPreconditionFailed)
					_, _ = w.Write([]byte(`{"error":"config_changed"}`))
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			t.Cleanup(server.Close)
			client, err := NewClient(server.URL, "fixture-management", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			client.WithConfigBackup(backup)
			_, _, err = client.MoveProviderFamily(context.Background(), "claude", "codex", 0, func(source ProviderFamilyEntry) (ProviderFamilyEntry, error) {
				return ProviderFamilyEntry{Keys: []ConfigAPIKey{{APIKey: "new-key", BaseURL: "https://relay.test"}}}, nil
			})
			if failBackup {
				if err == nil || writes != 0 {
					t.Fatal("backup failure did not block the write")
				}
			} else if !errors.Is(err, ErrConfigChanged) || writes != 1 {
				t.Fatalf("revision refusal=%v writes=%d", err, writes)
			}
		})
	}
}
