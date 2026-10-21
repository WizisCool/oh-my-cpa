package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// TestQuotaAttemptKeepsTheReadThatStartedLast pins what a stored attempt means when two reads of one
// credential overlap: the later *start*, not the later response. A slow failing read that began first
// can finish after a newer successful one, and completion order would let it report the credential as
// broken on every page that reads the attempt.
func TestQuotaAttemptKeepsTheReadThatStartedLast(t *testing.T) {
	const managementKey = "management-secret"

	// The gate holds the first usage read inside the gateway until the second has been recorded, so
	// the ordering is a handshake rather than a sleep.
	firstReadEntered := make(chan struct{})
	releaseFirstRead := make(chan struct{})
	var usageReads atomic.Int32

	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files":[{
				"id":"file-1","name":"codex-race.json","auth_index":"codex-race",
				"type":"codex","provider":"codex","disabled":false
			}]}`))
		case "/v8/management/requests/api-call":
			var payload struct {
				URL string `json:"url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			if !strings.Contains(payload.URL, "backend-api/wham/usage") {
				_, _ = writer.Write([]byte(`{"status_code":404,"body":{}}`))
				return
			}
			if usageReads.Add(1) == 1 {
				close(firstReadEntered)
				<-releaseFirstRead
				_, _ = writer.Write([]byte(`{"status_code":500,"body":{"message":"upstream unavailable"}}`))
				return
			}
			_, _ = writer.Write([]byte(`{"status_code":200,"body":{
				"plan_type":"pro",
				"rate_limit":{"primary_window":{"used_percent":3,"limit_window_seconds":18000,"reset_after_seconds":14400}}
			}}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()

	handler := testHandler(t, "")
	// A clock that moves forward on every reading of it keeps two overlapping starts strictly
	// ordered without depending on wall-clock resolution.
	base := time.Now()
	var ticks atomic.Int64
	handler.nowFn = func() time.Time { return base.Add(time.Duration(ticks.Add(1)) * time.Millisecond) }

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		UsageAddr:               strings.TrimPrefix(cpaServer.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	instance, err := handler.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		t.Fatal(err)
	}
	client, err := handler.clientForInstance(ctx, instance)
	if err != nil {
		t.Fatal(err)
	}
	file := management.AuthFile{Name: "codex-race.json", AuthIndex: "codex-race", Type: "codex", Provider: "codex"}

	var wg sync.WaitGroup
	read := func(isDone chan<- struct{}) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = handler.refreshQuotaReading(ctx, quota.NewServiceWithClock(client, handler.nowFn), file, nil)
			if isDone != nil {
				close(isDone)
			}
		}()
	}

	// The first read is held inside the gateway; the second runs to completion and records its
	// attempt while the first is still in flight, so the first finishes last on purpose.
	read(nil)
	<-firstReadEntered
	secondDone := make(chan struct{})
	read(secondDone)
	<-secondDone
	close(releaseFirstRead)
	wg.Wait()

	attempts, err := handler.repo.GetQuotaRefreshAttempts(ctx, []string{"codex-race"})
	if err != nil {
		t.Fatal(err)
	}
	attempt, ok := attempts["codex-race"]
	if !ok {
		t.Fatal("no attempt recorded")
	}
	if attempt.Outcome != repository.QuotaRefreshAttemptSucceeded || attempt.Error != "" {
		t.Fatalf("attempt = %+v, want the read that started last to be the one reported", attempt)
	}
}
