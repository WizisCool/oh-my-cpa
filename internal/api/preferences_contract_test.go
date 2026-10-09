package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"sort"
	"testing"
)

// This wire corpus is also consumed by the actual TypeScript client and shared
// browser fixture. Handler tests pin it independently, rather than trusting a
// generated response or a mock as the definition of the server's behavior.
func TestPreferencesSharedWireContract(t *testing.T) {
	t.Setenv("TZ", "UTC")
	payload, err := os.ReadFile("../../scripts/acceptance/contracts/preferences.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		AlternateServer struct {
			Timezone string          `json:"timezone"`
			Response json.RawMessage `json:"response"`
		} `json:"alternate_server"`
		Version        int      `json:"version"`
		ServerTimezone string   `json:"server_timezone"`
		KnownKeys      []string `json:"known_keys"`
		Cases          []struct {
			ID            string          `json:"id"`
			Method        string          `json:"method"`
			Path          string          `json:"path"`
			Body          *string         `json:"body"`
			Authenticated bool            `json:"authenticated"`
			Status        int             `json:"status"`
			Response      json.RawMessage `json:"response"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(payload, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Version != 1 || contract.ServerTimezone != "UTC" || len(contract.Cases) == 0 {
		t.Fatal("unsupported or empty preferences contract")
	}
	keys := make([]string, 0, len(knownPreferences))
	for key := range knownPreferences {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sort.Strings(contract.KnownKeys)
	if !reflect.DeepEqual(keys, contract.KnownKeys) {
		t.Fatalf("contract preference allowlist drift: actual=%v expected=%v", keys, contract.KnownKeys)
	}
	client, baseURL, _ := startDashboardTestServer(t, nil)
	seen := map[string]bool{}
	for _, entry := range contract.Cases {
		if entry.ID == "" || seen[entry.ID] {
			t.Fatalf("invalid contract case identity %q", entry.ID)
		}
		seen[entry.ID] = true
		t.Run(entry.ID, func(t *testing.T) {
			body := ""
			if entry.Body != nil {
				body = *entry.Body
			}
			request, err := http.NewRequest(entry.Method, baseURL+entry.Path, bytes.NewBufferString(body))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			caller := client
			if !entry.Authenticated {
				caller = &http.Client{}
			}
			response, err := caller.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			actual, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != entry.Status {
				t.Fatalf("status=%d expected=%d body=%s", response.StatusCode, entry.Status, actual)
			}
			if response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
				t.Fatalf("unexpected content type %q", response.Header.Get("Content-Type"))
			}
			// Authentication returns before the preference handler's cache policy.
			if entry.Authenticated && response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("preference response must remain non-cacheable")
			}
			var actualValue, expectedValue any
			if json.Unmarshal(actual, &actualValue) != nil || json.Unmarshal(entry.Response, &expectedValue) != nil || !reflect.DeepEqual(actualValue, expectedValue) {
				t.Fatalf("wire response drift: actual=%s expected=%s", actual, entry.Response)
			}
		})
	}
	t.Run("non-UTC deployment metadata", func(t *testing.T) {
		if contract.AlternateServer.Timezone == "" || contract.AlternateServer.Timezone == contract.ServerTimezone {
			t.Fatal("alternate deployment must distinguish metadata from the fallback")
		}
		t.Setenv("TZ", contract.AlternateServer.Timezone)
		caller, alternateURL, _ := startDashboardTestServer(t, nil)
		response, err := caller.Get(alternateURL + "/omc/api/v1/preferences")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		actual, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("unexpected status %d: %s", response.StatusCode, actual)
		}
		var actualValue, expectedValue any
		if json.Unmarshal(actual, &actualValue) != nil || json.Unmarshal(contract.AlternateServer.Response, &expectedValue) != nil || !reflect.DeepEqual(actualValue, expectedValue) {
			t.Fatalf("non-UTC metadata drift: actual=%s expected=%s", actual, contract.AlternateServer.Response)
		}
	})

}
