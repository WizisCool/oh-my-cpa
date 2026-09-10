// Package resp implements the minimal RESP2 client Oh My CPA needs to consume
// CLIProxyAPI's built-in Redis-compatible usage channel.
//
// CPA multiplexes HTTP and RESP on the same listening port by sniffing the
// first byte of each connection, so this client dials the host:port derived
// from the instance base URL and authenticates with the same management key.
// Only plain TCP is supported: a TLS instance negotiates HTTP through ALPN, so
// those deployments fall back to the HTTP usage-queue path.
package resp

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
	"time"
)

// MaxBulkSize bounds a single bulk string so a malformed or hostile stream
// cannot exhaust memory. CPA usage records are far below this.
const MaxBulkSize = 4 << 20

// ErrClosed reports use of a connection that has been closed.
var ErrClosed = errors.New("resp connection closed")

// Error is a RESP error reply ("-ERR ...").
type Error struct {
	Message string
}

func (e *Error) Error() string { return "resp error: " + e.Message }

// Reply is one parsed RESP2 value.
type Reply struct {
	// Type is the RESP prefix byte: '+', '-', ':', '$' or '*'.
	Type byte
	// String holds simple strings, error text and bulk payloads.
	String string
	// Integer holds ':' replies.
	Integer int64
	// Array holds '*' replies.
	Array []Reply
	// IsNil distinguishes a null bulk ($-1) from an empty bulk string.
	IsNil bool
}

// Conn is a single RESP connection. Commands are serialized internally; a
// subscription reader must be the only concurrent user of ReadReply.
type Conn struct {
	conn   net.Conn
	br     *bufio.Reader
	bw     *bufio.Writer
	mu     sync.Mutex
	closed bool
}

// Dial connects to addr and returns an unauthenticated connection.
func Dial(ctx context.Context, addr string, timeout time.Duration) (*Conn, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	return &Conn{conn: conn, br: bufio.NewReader(conn), bw: bufio.NewWriter(conn)}, nil
}

// Close terminates the connection. Safe to call repeatedly.
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return c.conn.Close()
}

// Auth authenticates with CPA's management key.
func (c *Conn) Auth(password string) error {
	return c.AuthContext(context.Background(), password)
}

// AuthContext bounds the handshake even when the peer accepts TCP but never replies.
func (c *Conn) AuthContext(ctx context.Context, password string) error {
	reply, err := c.Do(ctx, "AUTH", password)
	if err != nil {
		return err
	}
	if reply.Type == '-' {
		return &Error{Message: reply.String}
	}
	return nil
}

// Ping issues PING and reports the server error when unauthenticated.
func (c *Conn) Ping(ctx context.Context) error {
	reply, err := c.Do(ctx, "PING")
	if err != nil {
		return err
	}
	if reply.Type == '-' {
		return &Error{Message: reply.String}
	}
	return nil
}

// Do writes a command and reads exactly one reply. The whole exchange holds the
// connection lock so concurrent callers cannot interleave request and response.
func (c *Conn) Do(ctx context.Context, args ...string) (Reply, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.writeCommand(ctx, args); err != nil {
		return Reply{}, err
	}
	return c.readReply(ctx)
}

// LPop pops up to count entries from a list, returning nil when the queue is
// empty. CPA answers a count request with an array of bulk strings.
func (c *Conn) LPop(ctx context.Context, key string, count int) ([]string, error) {
	reply, err := c.Do(ctx, "LPOP", key, strconv.Itoa(count))
	if err != nil {
		return nil, err
	}
	if reply.Type == '-' {
		return nil, &Error{Message: reply.String}
	}
	if reply.IsNil {
		return nil, nil
	}
	switch reply.Type {
	case '*':
		items := make([]string, 0, len(reply.Array))
		for _, item := range reply.Array {
			if item.IsNil {
				continue
			}
			items = append(items, item.String)
		}
		return items, nil
	case '$':
		return []string{reply.String}, nil
	default:
		return nil, fmt.Errorf("unexpected LPOP reply type %q", reply.Type)
	}
}

// Subscribe starts a subscription to the given channels. CPA replies with one
// subscribe confirmation per channel; those are consumed here so the caller
// only sees message pushes.
func (c *Conn) Subscribe(ctx context.Context, channels ...string) error {
	args := append([]string{"SUBSCRIBE"}, channels...)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.writeCommand(ctx, args); err != nil {
		return err
	}
	for range channels {
		reply, err := c.readReply(ctx)
		if err != nil {
			return err
		}
		if reply.Type == '-' {
			return &Error{Message: reply.String}
		}
	}
	return nil
}

// Message is one pub/sub push.
type Message struct {
	Channel string
	Payload string
}

// ReadMessage blocks until a message push arrives on a subscribed channel.
// Subscribe confirmations and unsubscribe echoes are skipped so callers never
// mistake handshake frames for usage records.
func (c *Conn) ReadMessage(ctx context.Context) (Message, error) {
	for {
		reply, err := c.readReply(ctx)
		if err != nil {
			return Message{}, err
		}
		if reply.Type == '-' {
			return Message{}, &Error{Message: reply.String}
		}
		if reply.Type != '*' || len(reply.Array) < 3 {
			continue
		}
		switch reply.Array[0].String {
		case "message":
			return Message{Channel: reply.Array[1].String, Payload: reply.Array[2].String}, nil
		default:
			// subscribe / unsubscribe / pong confirmations are not data.
			continue
		}
	}
}

func (c *Conn) writeCommand(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("resp command requires at least one argument")
	}
	if c.closed {
		return ErrClosed
	}
	var builder strings.Builder
	builder.WriteString("*")
	builder.WriteString(strconv.Itoa(len(args)))
	builder.WriteString("\r\n")
	for _, arg := range args {
		builder.WriteString("$")
		builder.WriteString(strconv.Itoa(len(arg)))
		builder.WriteString("\r\n")
		builder.WriteString(arg)
		builder.WriteString("\r\n")
	}
	if err := c.withWriteDeadline(ctx, func() error {
		_, err := io.WriteString(c.bw, builder.String())
		if err != nil {
			return err
		}
		return c.bw.Flush()
	}); err != nil {
		return err
	}
	return nil
}

func (c *Conn) withWriteDeadline(ctx context.Context, fn func() error) error {
	if err := c.applyWriteDeadline(ctx); err != nil {
		return err
	}
	done := context.AfterFunc(ctx, func() { _ = c.conn.SetWriteDeadline(time.Unix(0, 0)) })
	defer done()
	err := fn()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return err
}

func (c *Conn) applyWriteDeadline(ctx context.Context) error {
	if deadline, ok := ctx.Deadline(); ok {
		return c.conn.SetWriteDeadline(deadline)
	}
	return c.conn.SetWriteDeadline(time.Time{})
}

// readReply reads one value. Callers either hold c.mu (Do) or are the sole
// reader of a dedicated subscription connection (ReadMessage).
func (c *Conn) readReply(ctx context.Context) (Reply, error) {
	if c.closed {
		return Reply{}, ErrClosed
	}
	if err := c.applyReadDeadline(ctx); err != nil {
		return Reply{}, err
	}
	done := context.AfterFunc(ctx, func() { _ = c.conn.SetReadDeadline(time.Unix(0, 0)) })
	defer done()
	reply, err := c.readReplyLocked()
	if ctxErr := ctx.Err(); ctxErr != nil && err != nil {
		return Reply{}, ctxErr
	}
	return reply, err
}

func (c *Conn) applyReadDeadline(ctx context.Context) error {
	if deadline, ok := ctx.Deadline(); ok {
		return c.conn.SetReadDeadline(deadline)
	}
	return c.conn.SetReadDeadline(time.Time{})
}

func (c *Conn) readReplyLocked() (Reply, error) {
	line, err := c.readLine()
	if err != nil {
		return Reply{}, err
	}
	if line == "" {
		return Reply{}, errors.New("resp: empty reply line")
	}
	switch line[0] {
	case '+':
		return Reply{Type: '+', String: line[1:]}, nil
	case '-':
		return Reply{Type: '-', String: line[1:]}, nil
	case ':':
		value, errParse := strconv.ParseInt(line[1:], 10, 64)
		if errParse != nil {
			return Reply{}, fmt.Errorf("resp: bad integer %q: %w", line[1:], errParse)
		}
		return Reply{Type: ':', Integer: value}, nil
	case '$':
		length, errParse := strconv.Atoi(line[1:])
		if errParse != nil {
			return Reply{}, fmt.Errorf("resp: bad bulk length %q: %w", line[1:], errParse)
		}
		if length < 0 {
			return Reply{Type: '$', IsNil: true}, nil
		}
		if length > MaxBulkSize {
			return Reply{}, fmt.Errorf("resp: bulk length %d exceeds cap %d", length, MaxBulkSize)
		}
		payload := make([]byte, length+2)
		if _, errRead := io.ReadFull(c.br, payload); errRead != nil {
			return Reply{}, fmt.Errorf("resp: read bulk: %w", errRead)
		}
		if payload[length] != '\r' || payload[length+1] != '\n' {
			return Reply{}, errors.New("resp: bulk payload not CRLF terminated")
		}
		return Reply{Type: '$', String: string(payload[:length])}, nil
	case '*':
		count, errParse := strconv.Atoi(line[1:])
		if errParse != nil {
			return Reply{}, fmt.Errorf("resp: bad array length %q: %w", line[1:], errParse)
		}
		if count < 0 {
			return Reply{Type: '*', IsNil: true}, nil
		}
		// Guard against a hostile length: elements must actually arrive, and
		// pre-allocating from an unvalidated number is a memory risk.
		if count > 100_000 {
			return Reply{}, fmt.Errorf("resp: array length %d exceeds cap", count)
		}
		items := make([]Reply, 0, min(count, 1024))
		for i := 0; i < count; i++ {
			item, errItem := c.readReplyLocked()
			if errItem != nil {
				return Reply{}, errItem
			}
			items = append(items, item)
		}
		return Reply{Type: '*', Array: items}, nil
	default:
		return Reply{}, fmt.Errorf("resp: unknown reply prefix %q", line[0])
	}
}

func (c *Conn) readLine() (string, error) {
	line, err := c.br.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimSuffix(line, "\n")
	line = strings.TrimSuffix(line, "\r")
	return line, nil
}
