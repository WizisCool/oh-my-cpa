package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

type builtinCycleLog struct{ completed chan string }

func (*builtinCycleLog) Enabled(context.Context, slog.Level) bool { return true }
func (log *builtinCycleLog) Handle(_ context.Context, record slog.Record) error {
	if record.Message == "builtin reconciliation complete" || record.Message == "builtin reconciliation stopped" || record.Message == "builtin reconciliation skipped: release refresh failed" {
		log.completed <- record.Message
	}
	return nil
}
func (log *builtinCycleLog) WithAttrs([]slog.Attr) slog.Handler { return log }
func (log *builtinCycleLog) WithGroup(string) slog.Handler      { return log }

func TestBuiltinWorkerRefreshFailureCannotExecuteCachedSnapshot(t *testing.T) {
	for _, trigger := range []string{"startup", "periodic", "queued"} {
		for _, failure := range []string{"transport", "checksum"} {
			t.Run(trigger+"/"+failure, func(t *testing.T) {
				handler, fixture, _, _, instance := newBuiltinFixture(t)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				catalogTicks := make(chan time.Time)
				stateTicks := make(chan time.Time)
				handler.builtins.newTicker = func(interval time.Duration) (<-chan time.Time, func()) {
					switch interval {
					case builtinCatalogRefreshInterval:
						return catalogTicks, func() {}
					case builtinDesiredStateInterval:
						return stateTicks, func() {}
					default:
						t.Errorf("production cadence changed: %s", interval)
						return make(chan time.Time), func() {}
					}
				}
				cycles := &builtinCycleLog{completed: make(chan string, 8)}
				handler.logger = slog.New(cycles)
				approved, _, err := handler.repo.LoadBuiltinCatalog(ctx)
				if err != nil {
					t.Fatal(err)
				}
				rejectedRaw := strings.ReplaceAll(string(builtinReleaseJSON(t, approved)), strings.Repeat("a", 64), "")
				original := http.DefaultTransport
				http.DefaultTransport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
					if request.URL.String() != "https://api.github.com/repos/WizisCool/omc-zcode-oauth/releases/latest" {
						return original.RoundTrip(request)
					}
					if failure == "transport" {
						return nil, errors.New("synthetic release network failure")
					}
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(rejectedRaw)), Request: request}, nil
				})
				defer func() { cancel(); handler.CloseBuiltinWorker(); http.DefaultTransport = original }()
				if err := handler.StartBuiltinWorker(ctx); err != nil {
					t.Fatal(err)
				}
				awaitCycle := func() {
					t.Helper()
					select {
					case <-cycles.completed:
					case <-ctx.Done():
						t.Fatal("worker did not complete its release check")
					}
				}
				awaitCycle()
				if trigger != "startup" {
					if trigger == "queued" {
						handler.queueBuiltinReconcile(instance)
					} else {
						select {
						case catalogTicks <- time.Now():
						case <-ctx.Done():
							t.Fatal(ctx.Err())
						}
					}
					awaitCycle()
				}
				// A synchronous tick handshake is the loop boundary, not a sleep or
				// an early warning that could race the forbidden mutation after it.
				select {
				case catalogTicks <- time.Now():
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if fixture.mutations.Load() != 0 {
					t.Fatalf("failed %s refresh executed cached snapshot after %s: CPA mutations=%d", failure, trigger, fixture.mutations.Load())
				}
				if handler.builtinCatalog().State().Status != "ready" {
					t.Fatal("refresh failure destroyed the last readonly release snapshot")
				}
			})
		}
	}
}
