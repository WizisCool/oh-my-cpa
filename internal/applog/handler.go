package applog

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

const (
	// maxMessageRunes and maxValueRunes bound one record so a single enormous error
	// string cannot turn the ring into an unbounded allocation.
	maxMessageRunes = 2000
	maxValueRunes   = 1000
	maxAttrs        = 32
)

// Handler forwards every record to the next handler and keeps a redacted copy.
//
// The copy is taken after the next handler's level check, so the console sees
// exactly what stderr sees - never a debug line the operator did not enable.
type Handler struct {
	next   slog.Handler
	buffer *Buffer
	attrs  []Attr
	group  string
}

// NewHandler tees next into buffer.
func NewHandler(next slog.Handler, buffer *Buffer) *Handler {
	return &Handler{next: next, buffer: buffer}
}

// BufferOf returns the buffer behind a logger built with NewHandler, or nil.
func BufferOf(logger *slog.Logger) *Buffer {
	if logger == nil {
		return nil
	}
	if handler, ok := logger.Handler().(*Handler); ok {
		return handler.buffer
	}
	return nil
}

func (h *Handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *Handler) Handle(ctx context.Context, record slog.Record) error {
	attrs := make([]Attr, 0, len(h.attrs)+record.NumAttrs())
	attrs = append(attrs, h.attrs...)
	record.Attrs(func(attr slog.Attr) bool {
		attrs = appendAttr(attrs, h.group, attr)
		return len(attrs) < maxAttrs
	})
	when := record.Time
	if when.IsZero() {
		when = time.Now()
	}
	h.buffer.Append(Record{
		LoggedAtMS: when.UnixMilli(),
		Level:      levelName(record.Level),
		Message:    bounded(security.RedactText(record.Message), maxMessageRunes),
		Attrs:      attrs,
	})
	return h.next.Handle(ctx, record)
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := &Handler{next: h.next.WithAttrs(attrs), buffer: h.buffer, group: h.group}
	next.attrs = append([]Attr(nil), h.attrs...)
	for _, attr := range attrs {
		next.attrs = appendAttr(next.attrs, h.group, attr)
	}
	return next
}

func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	return &Handler{next: h.next.WithGroup(name), buffer: h.buffer, attrs: h.attrs, group: joinKey(h.group, name)}
}

// appendAttr flattens groups into dotted keys and redacts every value. A field
// whose name marks it as a credential is replaced outright rather than pattern
// scrubbed: a secret with no recognisable shape would survive RedactText.
func appendAttr(attrs []Attr, prefix string, attr slog.Attr) []Attr {
	value := attr.Value.Resolve()
	if value.Kind() == slog.KindGroup {
		groupPrefix := joinKey(prefix, attr.Key)
		for _, child := range value.Group() {
			attrs = appendAttr(attrs, groupPrefix, child)
		}
		return attrs
	}
	if attr.Key == "" || len(attrs) >= maxAttrs {
		return attrs
	}
	key := joinKey(prefix, attr.Key)
	text := security.RedactedValue
	if !isSecretField(attr.Key) {
		text = bounded(security.RedactText(formatValue(value)), maxValueRunes)
	}
	return append(attrs, Attr{Key: key, Value: text})
}

// isSecretField widens security.IsSensitiveKey with every `*key`/`*keys` name. A
// log call names its fields freely (`management_key`, `upstream_key`), and a false
// positive only costs a value an operator can still find on stderr.
func isSecretField(key string) bool {
	if security.IsSensitiveKey(key) {
		return true
	}
	normalized := strings.ToLower(strings.TrimSpace(key))
	return strings.HasSuffix(normalized, "key") || strings.HasSuffix(normalized, "keys")
}

func formatValue(value slog.Value) string {
	switch value.Kind() {
	case slog.KindDuration:
		return value.Duration().String()
	case slog.KindTime:
		return value.Time().UTC().Format(time.RFC3339Nano)
	case slog.KindAny:
		if err, ok := value.Any().(error); ok {
			return err.Error()
		}
		return fmt.Sprint(value.Any())
	default:
		return value.String()
	}
}

func levelName(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "error"
	case level >= slog.LevelWarn:
		return "warn"
	case level >= slog.LevelInfo:
		return "info"
	default:
		return "debug"
	}
}

func joinKey(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}

func bounded(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimRight(string(runes[:limit]), " ") + "…"
}
