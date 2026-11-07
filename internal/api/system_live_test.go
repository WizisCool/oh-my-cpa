package api

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
)

func TestSystemLiveAnswersNoContentWithoutAReleaseService(t *testing.T) {
	handlers := map[string]*Handler{
		"no service": {},
		"demo": {
			cfg:     config.Config{IsDemoMode: true},
			release: &storedRelease{runningVersions: map[string]string{}},
		},
	}
	for name, handler := range handlers {
		recorder := httptest.NewRecorder()
		handler.systemLive(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/live", nil))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("%s: status = %d, want 204 so the console keeps polling", name, recorder.Code)
		}
	}
}

// TestSystemLiveStreamsAnUpdateSignal pins the contract the shell relies on: a stream that
// says "re-read" when a check records a result, carrying no data of its own.
func TestSystemLiveStreamsAnUpdateSignal(t *testing.T) {
	handler := &Handler{release: &storedRelease{runningVersions: map[string]string{}}}
	server := httptest.NewServer(http.HandlerFunc(handler.systemLive))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if got := response.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type = %q, want an event stream", got)
	}

	reader := bufio.NewReader(response.Body)
	readFrame := func() string {
		t.Helper()
		var frame strings.Builder
		for {
			line, errRead := reader.ReadString('\n')
			if errRead != nil {
				t.Fatalf("reading the stream: %v", errRead)
			}
			if line == "\n" {
				return frame.String()
			}
			frame.WriteString(line)
		}
	}

	if frame := readFrame(); !strings.Contains(frame, "event: ready") {
		t.Fatalf("first frame = %q, want a ready event", frame)
	}
	handler.NotifyUpdateObservations()
	if frame := readFrame(); !strings.Contains(frame, "event: updates") || !strings.Contains(frame, "data: {}") {
		t.Fatalf("signal frame = %q, want an empty updates event", frame)
	}
}

// TestUpdateSignalsMergeABurst pins the delivery rule: a reader that has not consumed its
// previous signal keeps one, so a sweep publishing per product cannot queue up reads.
func TestUpdateSignalsMergeABurst(t *testing.T) {
	var signals updateSignals
	channel, unsubscribe, err := signals.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

	signals.Publish()
	signals.Publish()
	signals.Publish()

	select {
	case <-channel:
	case <-time.After(time.Second):
		t.Fatal("no signal was delivered")
	}
	select {
	case <-channel:
		t.Fatal("a burst queued more than one signal")
	case <-time.After(20 * time.Millisecond):
	}
}

// TestSystemLiveRefusesReadersPastTheLimit pins the refusal contract: past the reader limit the
// stream answers 503, which is what tells the console to keep polling and retry later rather
// than hold a connection the server will not serve.
func TestSystemLiveRefusesReadersPastTheLimit(t *testing.T) {
	handler := &Handler{release: &storedRelease{runningVersions: map[string]string{}}}
	for range MAX_UPDATE_SUBSCRIBERS {
		_, unsubscribe, err := handler.updateSignals.Subscribe()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(unsubscribe)
	}
	recorder := httptest.NewRecorder()
	handler.systemLive(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/live", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), ErrTooManyUpdateSubscribers.Error()) {
		t.Fatalf("body = %s, want the reader-limit error", recorder.Body.String())
	}
}

// TestSystemLiveEndsWhenTheStreamsClose pins the shutdown contract: Shutdown waits for active
// connections to go idle, and an event stream never does on its own, so one open console tab
// would otherwise hold the process until the shutdown deadline.
func TestSystemLiveEndsWhenTheStreamsClose(t *testing.T) {
	handler := &Handler{release: &storedRelease{runningVersions: map[string]string{}}}
	server := httptest.NewServer(http.HandlerFunc(handler.systemLive))
	defer server.Close()

	response, err := (&http.Client{Timeout: 5 * time.Second}).Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for {
		line, errRead := reader.ReadString('\n')
		if errRead != nil {
			t.Fatalf("reading the stream: %v", errRead)
		}
		if line == "\n" {
			break
		}
	}

	ended := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, response.Body)
		close(ended)
	}()
	handler.CloseUpdateStreams()
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("closing the update streams did not end the open stream")
	}
}

func TestSystemLiveRefusesReadersAfterClose(t *testing.T) {
	handler := &Handler{release: &storedRelease{runningVersions: map[string]string{}}}
	handler.CloseUpdateStreams()
	recorder := httptest.NewRecorder()
	handler.systemLive(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/live", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 once the streams are closed", recorder.Code)
	}
}
