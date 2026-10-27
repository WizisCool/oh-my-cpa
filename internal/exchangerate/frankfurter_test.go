package exchangerate

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/testkit"
)

func TestFrankfurterProjection(t *testing.T) {
	testkit.Cases(t, "testdata/golden/frankfurter", func(t *testing.T, input testkit.Case) any {
		rates, err := DecodeFrankfurter(input.Body)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return rates
	})
}

func TestFrankfurterDownloadBoundary(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden/frankfurter/latest.input.json")
	if err != nil {
		t.Fatal(err)
	}
	var input testkit.Case
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}

	for _, scenario := range []struct {
		name   string
		status int
		body   string
	}{
		{"upstream failure", http.StatusBadGateway, `{"message":"unavailable"}`},
		{"truncated document", http.StatusOK, `[{"date":"2026-10-27"`},
		{"redirect", http.StatusFound, `[]`},
		{"oversized valid document", http.StatusOK, string(input.Body) + strings.Repeat(" ", 1<<20)},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Query().Get("base") != "USD" || request.Header.Get("Authorization") != "" {
					t.Error("request must be public USD reference data")
				}
				writer.WriteHeader(scenario.status)
				_, _ = writer.Write([]byte(scenario.body))
			}))
			defer server.Close()
			client := NewFrankfurterClient()
			transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
				target, err := http.NewRequestWithContext(request.Context(), request.Method, server.URL+request.URL.RequestURI(), nil)
				if err != nil {
					return nil, err
				}
				target.Header = request.Header
				return http.DefaultTransport.RoundTrip(target)
			})
			client.client.Transport = transport
			if _, err := client.Fetch(context.Background()); err == nil {
				t.Fatal("invalid download was accepted")
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

type scheduleStore struct {
	snapshot Snapshot
	read     func()
	save     func()
	// saveErr fails the next write without publishing it, the way a locked database does.
	saveErr error
}

func (s *scheduleStore) ReadExchangeRates(context.Context) (Snapshot, error) {
	if s.read != nil {
		s.read()
	}
	return s.snapshot, nil
}
func (s *scheduleStore) SaveExchangeRates(_ context.Context, snapshot Snapshot) error {
	if s.saveErr != nil {
		s.saveErr = nil
		return errors.New("database is locked")
	}
	s.snapshot = snapshot
	if s.save != nil {
		s.save()
	}
	return nil
}

type fetchFunc func(context.Context) ([]Rate, error)

func (f fetchFunc) Fetch(ctx context.Context) ([]Rate, error) { return f(ctx) }

func TestPersistedScheduleAndConcurrentRefresh(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	store := &scheduleStore{snapshot: Snapshot{Rates: []Rate{}, AttemptedAtMS: now.UnixMilli()}}
	ctx, cancel := context.WithCancel(context.Background())
	store.read = cancel
	service := NewService(store, fetchFunc(func(context.Context) ([]Rate, error) {
		t.Error("fresh persisted cache must not download on restart")
		return nil, nil
	}), nil)
	service.clock = func() time.Time { return now }
	if err := service.Run(ctx); err != nil {
		t.Fatal(err)
	}
	store.read = nil
	store.snapshot.AttemptedAtMS = now.Add(-RefreshInterval).UnixMilli()
	dueContext, stopDue := context.WithTimeout(context.Background(), time.Second)
	defer stopDue()
	store.save = stopDue
	service.fetcher = fetchFunc(func(context.Context) ([]Rate, error) {
		return []Rate{{Currency: "MYR", Rate: 4, Date: "2026-10-27"}}, nil
	})
	if err := service.Run(dueContext); err != nil {
		t.Fatal(err)
	}
	if store.snapshot.UpdatedAtMS != now.UnixMilli() {
		t.Fatal("a due persisted schedule did not publish fresh rates")
	}
	store.save = nil
	arrived, release := make(chan struct{}), make(chan struct{})
	service.fetcher = fetchFunc(func(context.Context) ([]Rate, error) {
		close(arrived)
		<-release
		return []Rate{{Currency: "MYR", Rate: 4, Date: "2026-10-27"}}, nil
	})
	done := make(chan error, 1)
	go func() { _, err := service.Refresh(context.Background()); done <- err }()
	<-arrived
	if _, err := service.Refresh(context.Background()); !errors.Is(err, ErrRefreshRunning) {
		t.Errorf("concurrent refresh = %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	// A write that fails once retries on the short delay instead of ending the loop, so a
	// locked database cannot freeze display conversion until a restart.
	store.snapshot = Snapshot{Rates: []Rate{}, AttemptedAtMS: now.Add(-RefreshInterval).UnixMilli()}
	store.saveErr = errors.New("database is locked")
	service.fetcher = fetchFunc(func(context.Context) ([]Rate, error) {
		return []Rate{{Currency: "MYR", Rate: 4, Date: "2026-10-27"}}, nil
	})
	service.retryDelay = time.Millisecond
	retryContext, stopRetry := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopRetry()
	store.save = stopRetry
	if err := service.Run(retryContext); err != nil {
		t.Fatal(err)
	}
	store.save = nil
	if store.snapshot.UpdatedAtMS != now.UnixMilli() {
		t.Fatal("a transient write failure stopped the loop before it could publish")
	}
}
