package resp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// fakeServer is a minimal RESP server that answers scripted replies so the
// client is tested against the real wire format rather than a mock.
type fakeServer struct {
	listener net.Listener
	// commands receives each decoded command the client sends.
	commands chan []string
	// responder writes replies for a command.
	responder func(conn net.Conn, reader *bufio.Reader, args []string)
	// halt closes when the test finishes so silent responders can return.
	halt chan struct{}
}

func newFakeServer(t *testing.T, responder func(net.Conn, *bufio.Reader, []string)) *fakeServer {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &fakeServer{
		listener:  listener,
		commands:  make(chan []string, 16),
		responder: responder,
		halt:      make(chan struct{}),
	}
	go server.serve()
	t.Cleanup(func() {
		close(server.halt)
		_ = listener.Close()
	})
	return server
}

func (s *fakeServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeServer) handle(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for {
		args, err := readCommand(reader)
		if err != nil {
			return
		}
		s.commands <- args
		s.responder(conn, reader, args)
	}
}

func (s *fakeServer) address() string { return s.listener.Addr().String() }

func readCommand(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	if len(line) == 0 || line[0] != '*' {
		return nil, errors.New("expected array")
	}
	var count int
	if _, errScan := fmtSscan(line[1:], &count); errScan != nil {
		return nil, errScan
	}
	args := make([]string, 0, count)
	for i := 0; i < count; i++ {
		header, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		header = strings.TrimRight(header, "\r\n")
		if len(header) == 0 || header[0] != '$' {
			return nil, errors.New("expected bulk")
		}
		var length int
		if _, errScan := fmtSscan(header[1:], &length); errScan != nil {
			return nil, errScan
		}
		payload := make([]byte, length+2)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return nil, err
		}
		args = append(args, string(payload[:length]))
	}
	return args, nil
}

// fmtSscan avoids importing fmt just for integer parsing in the test helper.
func fmtSscan(raw string, target *int) (int, error) {
	value := 0
	if raw == "" {
		return 0, errors.New("empty number")
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return 0, errors.New("bad number")
		}
		value = value*10 + int(raw[i]-'0')
	}
	*target = value
	return len(raw), nil
}

func writeRaw(conn net.Conn, payload string) {
	_, _ = io.WriteString(conn, payload)
}

func writeBulk(conn net.Conn, value string) {
	writeRaw(conn, "$"+itoa(len(value))+"\r\n"+value+"\r\n")
}

func writeNilBulk(conn net.Conn) { writeRaw(conn, "$-1\r\n") }

func writeArray(conn net.Conn, items ...string) {
	writeRaw(conn, "*"+itoa(len(items))+"\r\n")
	for _, item := range items {
		writeBulk(conn, item)
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	if negative {
		return "-" + digits
	}
	return digits
}

func dialTestClient(t *testing.T, addr string) *Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := Dial(ctx, addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestAuthSucceedsAndSendsPassword(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, args []string) {
		if strings.EqualFold(args[0], "AUTH") {
			writeRaw(conn, "+OK\r\n")
			return
		}
		writeRaw(conn, "-ERR unexpected\r\n")
	})
	client := dialTestClient(t, server.address())
	if err := client.Auth("admin"); err != nil {
		t.Fatalf("auth failed: %v", err)
	}
	command := <-server.commands
	if len(command) != 2 || command[0] != "AUTH" || command[1] != "admin" {
		t.Fatalf("AUTH wire format wrong: %#v", command)
	}
}

func TestAuthSurfacesServerError(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "-ERR invalid password\r\n")
	})
	client := dialTestClient(t, server.address())
	err := client.Auth("wrong")
	var respErr *Error
	if !errors.As(err, &respErr) || !strings.Contains(respErr.Message, "invalid password") {
		t.Fatalf("auth error not surfaced: %v", err)
	}
}

func TestLPopReturnsBatchAndEmpty(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, args []string) {
		switch strings.Join(args, " ") {
		case "LPOP usage 2":
			writeArray(conn, `{"request_id":"a"}`, `{"request_id":"b"}`)
		case "LPOP empty 1":
			writeNilBulk(conn)
		case "LPOP single 5":
			writeBulk(conn, `{"request_id":"solo"}`)
		default:
			writeRaw(conn, "+OK\r\n")
		}
	})
	client := dialTestClient(t, server.address())
	ctx := context.Background()

	items, err := client.LPop(ctx, "usage", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0] != `{"request_id":"a"}` {
		t.Fatalf("batch decode wrong: %#v", items)
	}
	if items, err = client.LPop(ctx, "empty", 1); err != nil || items != nil {
		t.Fatalf("nil bulk should decode as empty, got %#v err %v", items, err)
	}
	// Older servers may answer a count request with a single bulk.
	if items, err = client.LPop(ctx, "single", 5); err != nil || len(items) != 1 {
		t.Fatalf("single bulk not handled: %#v err %v", items, err)
	}
}

func TestSubscribeConsumesConfirmationsThenReadsMessages(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, args []string) {
		switch strings.ToUpper(args[0]) {
		case "SUBSCRIBE":
			writeArray(conn, "subscribe", args[1], "1")
			// CPA pushes a control frame right after the handshake.
			writeArray(conn, "message", args[1], `{"support_refresh":true}`)
			writeArray(conn, "message", args[1], `{"request_id":"live-1"}`)
		default:
			writeRaw(conn, "+OK\r\n")
		}
	})
	client := dialTestClient(t, server.address())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := client.Subscribe(ctx, "usage"); err != nil {
		t.Fatal(err)
	}
	message, err := client.ReadMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if message.Channel != "usage" || message.Payload != `{"support_refresh":true}` {
		t.Fatalf("first push wrong: %+v", message)
	}
	message, err = client.ReadMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if message.Payload != `{"request_id":"live-1"}` {
		t.Fatalf("second push wrong: %+v", message)
	}
}

func TestReadMessageReportsServerError(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "*1\r\n$3\r\nERR\r\n")
		writeRaw(conn, "-ERR bad channel\r\n")
	})
	client := dialTestClient(t, server.address())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := client.ReadMessage(ctx); err == nil {
		t.Fatal("short array followed by error should surface an error")
	}
}

func TestReadRejectsOversizedBulk(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "$"+itoa(MaxBulkSize+1)+"\r\n")
		writeRaw(conn, strings.Repeat("x", 1024))
	})
	client := dialTestClient(t, server.address())
	if _, err := client.Do(context.Background(), "PING"); err == nil {
		t.Fatal("oversized bulk length must be rejected before allocation")
	}
}

func TestReadRejectsUnknownPrefix(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "?bogus\r\n")
	})
	client := dialTestClient(t, server.address())
	if _, err := client.Do(context.Background(), "PING"); err == nil {
		t.Fatal("unknown reply prefix must error")
	}
}

func TestReadRejectsAbsurdArrayLength(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "*999999999\r\n")
	})
	client := dialTestClient(t, server.address())
	if _, err := client.Do(context.Background(), "PING"); err == nil {
		t.Fatal("array length beyond cap must error")
	}
}

func TestCancelledContextAbortsBlockingRead(t *testing.T) {
	// halt lets this responder park without leaking a goroutine past the test.
	halt := make(chan struct{})
	t.Cleanup(func() { close(halt) })
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, args []string) {
		if strings.EqualFold(args[0], "SUBSCRIBE") {
			writeArray(conn, "subscribe", args[1], "1")
			// Then go silent: the reader must unblock on context cancellation.
			<-halt
			return
		}
		writeRaw(conn, "+OK\r\n")
	})
	client := dialTestClient(t, server.address())
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if err := client.Subscribe(ctx, "usage"); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := client.ReadMessage(ctx); err == nil {
		t.Fatal("blocking read must return an error once the context expires")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("read did not honour cancellation, took %s", elapsed)
	}
}

func TestClosedConnectionRejectsCommands(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "+OK\r\n")
	})
	client := dialTestClient(t, server.address())
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close must be idempotent: %v", err)
	}
	if _, err := client.Do(context.Background(), "PING"); err == nil {
		t.Fatal("command on closed connection must fail")
	}
}

func TestCloseUnblocksInFlightDo(t *testing.T) {
	halt := make(chan struct{})
	t.Cleanup(func() { close(halt) })
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		<-halt
	})
	client := dialTestClient(t, server.address())

	done := make(chan error, 1)
	go func() {
		_, err := client.Do(context.Background(), "PING")
		done <- err
	}()
	<-server.commands // the server received the command and is intentionally silent
	if err := client.Close(); err != nil {
		t.Fatalf("close failed: %v", err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("an in-flight command must fail after close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not unblock the in-flight command")
	}
}

func TestReadRejectsOversizedControlLine(t *testing.T) {
	server := newFakeServer(t, func(conn net.Conn, _ *bufio.Reader, _ []string) {
		writeRaw(conn, "+"+strings.Repeat("x", maxLineSize+1)+"\r\n")
	})
	client := dialTestClient(t, server.address())
	if _, err := client.Do(context.Background(), "PING"); err == nil {
		t.Fatal("oversized control line must be rejected")
	}
}
