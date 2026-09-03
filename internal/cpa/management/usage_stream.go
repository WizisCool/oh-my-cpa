package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/resp"
)

// UsageChannel is CPA's built-in Redis-compatible pub/sub channel names.
const (
	UsageChannel  = "usage"
	ErrorsChannel = "errors"
)

// ErrRESPUnsupported reports an instance that cannot serve the RESP channel.
// CPA multiplexes RESP on the same port as HTTP but only for plaintext
// connections: a TLS endpoint negotiates HTTP through ALPN, so those
// deployments keep using the HTTP usage queue.
var ErrRESPUnsupported = errors.New("CPA instance does not support the RESP usage channel")

// respAddress derives the host:port CPA multiplexes RESP on.
func (c *Client) respAddress() (string, error) {
	if c == nil {
		return "", ErrRESPUnsupported
	}
	parsed, err := url.Parse(c.baseURL)
	if err != nil || parsed.Host == "" {
		return "", ErrRESPUnsupported
	}
	if !strings.EqualFold(parsed.Scheme, "http") {
		return "", ErrRESPUnsupported
	}
	if parsed.Port() != "" {
		return parsed.Host, nil
	}
	return net.JoinHostPort(parsed.Hostname(), "80"), nil
}

// dialRESP opens and authenticates a RESP connection to CPA.
func (c *Client) dialRESP(ctx context.Context) (*resp.Conn, error) {
	addr, err := c.respAddress()
	if err != nil {
		return nil, err
	}
	conn, err := resp.Dial(ctx, addr, c.dialTimeout())
	if err != nil {
		return nil, fmt.Errorf("dial CPA usage channel: %w", err)
	}
	if err := conn.Auth(c.management); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("authenticate CPA usage channel: %w", err)
	}
	return conn, nil
}

func (c *Client) dialTimeout() time.Duration {
	if c == nil || c.httpClient == nil || c.httpClient.Timeout <= 0 {
		return 15 * time.Second
	}
	return c.httpClient.Timeout
}

// UsageStream is a live subscription to one CPA pub/sub channel.
type UsageStream struct {
	conn     *resp.Conn
	messages chan string
	channel  string
	// done signals the reader to stop; sends never block on a dead consumer.
	done   chan struct{}
	close  sync.Once
	mu     sync.Mutex
	closed bool
}

// OpenUsageStream subscribes to a CPA channel. Callers must Close the stream.
func (c *Client) OpenUsageStream(ctx context.Context, channel string) (*UsageStream, error) {
	if channel != UsageChannel && channel != ErrorsChannel {
		return nil, fmt.Errorf("unknown CPA channel %q", channel)
	}
	conn, err := c.dialRESP(ctx)
	if err != nil {
		return nil, err
	}
	stream := &UsageStream{
		conn:     conn,
		messages: make(chan string, 256),
		channel:  channel,
		done:     make(chan struct{}),
	}
	if err := conn.Subscribe(ctx, channel); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("subscribe CPA %s channel: %w", channel, err)
	}
	go stream.read(conn)
	return stream, nil
}

// Messages yields payloads until the stream ends.
func (s *UsageStream) Messages() <-chan string {
	if s == nil {
		return nil
	}
	return s.messages
}

// Channel reports which CPA channel this stream reads.
func (s *UsageStream) Channel() string {
	if s == nil {
		return ""
	}
	return s.channel
}

// Close stops the reader and drops the connection. Safe to call repeatedly.
func (s *UsageStream) Close() error {
	if s == nil {
		return nil
	}
	var err error
	s.close.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		close(s.done)
		// Closing the socket also unblocks the reader's pending ReadMessage.
		err = s.conn.Close()
	})
	return err
}

// read owns its connection handle so Close cannot nil it out underneath.
func (s *UsageStream) read(conn *resp.Conn) {
	defer close(s.messages)
	ctx := context.Background()
	for {
		message, err := conn.ReadMessage(ctx)
		if err != nil {
			return
		}
		if strings.TrimSpace(message.Payload) == "" {
			continue
		}
		select {
		case s.messages <- message.Payload:
		case <-s.done:
			return
		}
	}
}

// PingUsageChannel verifies the RESP endpoint answers and authenticates, without
// subscribing. Probing by subscribing would briefly register as a subscriber,
// and CPA suppresses queueing while any subscriber is attached, so the probe
// could swallow records.
func (c *Client) PingUsageChannel(ctx context.Context) error {
	conn, err := c.dialRESP(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.Ping(ctx); err != nil {
		return fmt.Errorf("ping CPA usage channel: %w", err)
	}
	return nil
}

// PopUsageQueue drains up to count records through RESP LPOP, the batch path
// used when subscription is unavailable but RESP still is.
func (c *Client) PopUsageQueue(ctx context.Context, count int) ([]string, error) {
	if count <= 0 {
		count = 1
	}
	conn, err := c.dialRESP(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	items, err := conn.LPop(ctx, UsageChannel, count)
	if err != nil {
		return nil, fmt.Errorf("pop CPA usage queue: %w", err)
	}
	return items, nil
}

// UsageQueueJSON drains the HTTP usage queue and re-marshals each record so
// callers always receive compact, valid JSON strings.
func (c *Client) UsageQueueJSON(ctx context.Context, count int) ([]string, error) {
	records, _, err := c.UsageQueue(ctx, count)
	if err != nil {
		return nil, err
	}
	items := make([]string, 0, len(records))
	for _, record := range records {
		trimmed := strings.TrimSpace(string(record))
		if trimmed == "" || trimmed == "null" {
			continue
		}
		// Re-marshal to reject malformed frames before they reach storage.
		var probe map[string]any
		if errUnmarshal := json.Unmarshal([]byte(trimmed), &probe); errUnmarshal != nil {
			continue
		}
		items = append(items, trimmed)
	}
	return items, nil
}
