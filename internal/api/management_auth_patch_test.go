package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestManagementAuthFilesPatchFieldsSuccess(t *testing.T) {
	recorder := &cpaRecorder{}
	runtimePriority := 0
	runtimeWeight := int64(0)
	runtimeNote := ""
	cpaServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		recorder.record(request)
		writer.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/models") {
			_, _ = writer.Write([]byte(`{"models":[{"id":"gpt-4o","display_name":"GPT-4o"}]}`))
			return
		}
		if request.Method == http.MethodPatch && strings.HasSuffix(request.URL.Path, "/fields") {
			var payload struct {
				Priority int    `json:"priority"`
				Weight   int64  `json:"weight"`
				Note     string `json:"note"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode patch: %v", err)
			}
			runtimePriority = payload.Priority
			runtimeWeight = payload.Weight
			runtimeNote = payload.Note
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"files":[{"id":"test.json","name":"test.json","auth_index":"idx-1","provider":"claude","priority":` +
			strconv.Itoa(runtimePriority) + `,"weight":` + strconv.FormatInt(runtimeWeight, 10) + `,"note":"` + runtimeNote + `"}]}`))
	}))
	defer cpaServer.Close()

	db, err := repository.Open(context.Background(), authFilesMemoryDSN("auth_files_facade_patch"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := repository.New(db)
	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte("cpa-management-key"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}
	authManager, err := auth.New("management-secret-value", "/omc", "")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{BasePath: "/omc", Version: "test"}, repo, cipher, nil, authManager)
	appServer := httptest.NewServer(handler.Router())
	defer appServer.Close()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(appServer.URL+"/omc/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret-value"}`))
	if err != nil || loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v", err)
	}

	// 1. PATCH fields with safe metadata
	patchBody := `{"name":"test.json","priority":5,"weight":10,"note":"priority line"}`
	resp, payload := doJSON(t, client, http.MethodPatch, appServer.URL+"/omc/api/v1/management/auth-files/fields", patchBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("patch fields status = %d body = %s", resp.StatusCode, payload)
	}

	// 2. GET models
	resp, payload = doJSON(t, client, http.MethodGet, appServer.URL+"/omc/api/v1/management/auth-files/models?name=test.json", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get models status = %d body = %s", resp.StatusCode, payload)
	}
	var modelsRes struct {
		Models []managementAuthFileModel `json:"models"`
	}
	if err := json.Unmarshal(payload, &modelsRes); err != nil || len(modelsRes.Models) != 1 {
		t.Fatalf("unexpected models response: %s", payload)
	}
	if modelsRes.Models[0].ID != "gpt-4o" {
		t.Fatalf("expected model gpt-4o, got %s", modelsRes.Models[0].ID)
	}
}

func TestNormalizeManagementAuthFileRoutingFields(t *testing.T) {
	for _, input := range []int64{-3, 0, 1} {
		value, err := normalizeManagementAuthFileField("weight", json.Number(strconv.FormatInt(input, 10)))
		if err != nil {
			t.Fatalf("weight %d: %v", input, err)
		}
		want := input
		if want < 0 {
			want = 0
		}
		if got, errNumber := numberInt64(value); errNumber != nil || got != want {
			t.Fatalf("weight %d normalized to %v, want %d", input, value, want)
		}
	}
	if _, err := normalizeManagementAuthFileField("weight", json.Number("1000001")); err == nil {
		t.Fatal("weight above the CPA maximum was accepted")
	}
	priority, err := normalizeManagementAuthFileField("priority", json.Number("-7"))
	if err != nil {
		t.Fatal(err)
	}
	if got, errNumber := numberInt64(priority); errNumber != nil || got != -7 {
		t.Fatalf("priority normalized to %v, want -7", priority)
	}
}
