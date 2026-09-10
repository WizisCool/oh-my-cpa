package management_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

// probeServer intentionally implements CPA's limited command set, NOT Redis:
// AUTH works, SUBSCRIBE streams, and PING is unsupported.
type probeServer struct {
	listener    net.Listener
	mu          sync.Mutex
	commands    []string
	connections map[net.Conn]bool
	wg          sync.WaitGroup
	silent      bool
}

func newProbeServer(t *testing.T, silent bool) *probeServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &probeServer{listener: listener, connections: map[net.Conn]bool{}, silent: silent}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.connections[conn] = true
			s.mu.Unlock()
			s.wg.Add(1)
			go s.serve(conn)
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		s.mu.Lock()
		for conn := range s.connections {
			_ = conn.Close()
		}
		s.mu.Unlock()
		s.wg.Wait()
	})
	return s
}

func (s *probeServer) serve(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()
	defer func() { s.mu.Lock(); delete(s.connections, conn); s.mu.Unlock() }()
	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		if !strings.HasPrefix(line, "*") {
			s.mu.Lock()
			s.commands = append(s.commands, "HTTP")
			s.mu.Unlock()
			_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
			return
		}
		count, err := strconv.Atoi(strings.TrimSpace(line[1:]))
		if err != nil {
			return
		}
		args := make([]string, 0, count)
		for i := 0; i < count; i++ {
			sizeLine, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			size, err := strconv.Atoi(strings.TrimSpace(sizeLine[1:]))
			if err != nil || size < 0 {
				return
			}
			payload := make([]byte, size+2)
			if _, err := io.ReadFull(reader, payload); err != nil {
				return
			}
			args = append(args, string(payload[:size]))
		}
		if len(args) == 0 {
			return
		}
		command := strings.ToUpper(args[0])
		s.mu.Lock()
		s.commands = append(s.commands, command)
		s.mu.Unlock()
		if s.silent {
			_, _ = io.Copy(io.Discard, reader)
			return
		}
		switch command {
		case "AUTH":
			_, _ = io.WriteString(conn, "+OK\r\n")
		case "SUBSCRIBE":
			_, _ = io.WriteString(conn, "*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n")
			payload := `{"request_id":"probe-test","model":"fixture","total_tokens":1}`
			_, _ = fmt.Fprintf(conn, "*3\r\n$7\r\nmessage\r\n$5\r\nusage\r\n$%d\r\n%s\r\n", len(payload), payload)
		case "LPOP":
			_, _ = io.WriteString(conn, "*0\r\n")
		default:
			_, _ = io.WriteString(conn, "-ERR unknown command 'ping'\r\n")
		}
	}
}

func (s *probeServer) snapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.commands, ",")
}

func TestUsageProbeOnlyAuthenticates(t *testing.T) {
	server := newProbeServer(t, false)
	client, err := management.NewClient("http://"+server.listener.Addr().String(), "fixture-key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ProbeUsageChannel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := server.snapshot(); got != "AUTH" {
		t.Fatalf("probe consumed/subscribed or required unsupported PING: %s", got)
	}
}

func TestUsageHandshakeHonorsTimeoutAndCancellation(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			server := newProbeServer(t, true)
			timeout := 30 * time.Millisecond
			if cancelled {
				timeout = time.Hour
			}
			client, _ := management.NewClient("http://"+server.listener.Addr().String(), "fixture-key", timeout, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cancelled {
				time.AfterFunc(30*time.Millisecond, cancel)
			}
			done := make(chan error, 1)
			go func() { done <- client.ProbeUsageChannel(ctx) }()
			select {
			case err := <-done:
				want := context.DeadlineExceeded
				if cancelled {
					want = context.Canceled
				}
				// The socket deadline can fire just before the context timer.
				var timeout net.Error
				deadlineTimeout := !cancelled && errors.As(err, &timeout) && timeout.Timeout()
				if !errors.Is(err, want) && !deadlineTimeout {
					t.Fatalf("got %v, want %v", err, want)
				}
			case <-time.After(time.Second):
				t.Fatal("AUTH ignored its deadline/cancellation")
			}
		})
	}
}

type streamAdapter struct{ *management.Client }

func (s streamAdapter) OpenUsageStream(ctx context.Context, channel string) (ingest.Stream, error) {
	return s.Client.OpenUsageStream(ctx, channel)
}

type captureSink struct{ captured chan []string }

func (s captureSink) AppendUsageInbox(_ context.Context, _, _ string, payloads []string, _ time.Time) (int, error) {
	s.captured <- append([]string(nil), payloads...)
	return len(payloads), nil
}

func TestAutoModeSubscribesWhenCPADoesNotSupportPing(t *testing.T) {
	server := newProbeServer(t, false)
	client, _ := management.NewClient("http://"+server.listener.Addr().String(), "fixture-key", time.Second, false)
	captured := make(chan []string, 10)
	runner, err := ingest.NewRunner("default", streamAdapter{client}, captureSink{captured}, nil, nil, ingest.Config{
		Mode: ingest.ModeAuto, IdleInterval: 10 * time.Millisecond, BackfillInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	select {
	case payloads := <-captured:
		if len(payloads) != 1 || !strings.Contains(payloads[0], "probe-test") {
			t.Fatal(payloads)
		}
	case <-time.After(time.Second):
		t.Fatalf("auto collector fell back instead of capturing: %s", server.snapshot())
	}
	if runner.Status().Mode != ingest.ModeSubscribe {
		t.Fatal(runner.Status().Mode)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("subscription shutdown hung")
	}
	if got := server.snapshot(); got != "AUTH,AUTH,SUBSCRIBE" {
		t.Fatalf("unexpected commands (no PING, HTTP or destructive probe allowed): %s", got)
	}
}
