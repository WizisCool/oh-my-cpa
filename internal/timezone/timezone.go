// Package timezone resolves deployment and operator-selected calendar time.
package timezone

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	_ "time/tzdata"
)

var ErrInvalid = errors.New("invalid_timezone")

// Load accepts portable IANA names, never paths or the process-relative Local alias.
func Load(name string) (*time.Location, error) {
	if name == "" || name == "Local" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") || strings.ContainsAny(name, "\\\x00") {
		return nil, ErrInvalid
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, ErrInvalid
	}
	return location, nil
}

func ServerLocation() *time.Location {
	if name, exists := os.LookupEnv("TZ"); exists {
		if name == "" {
			return time.UTC
		}
		name = strings.TrimPrefix(name, ":")
		name = strings.TrimPrefix(name, "/usr/share/zoneinfo/")
		if location, err := Load(name); err == nil {
			return location
		}
	}
	if path, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if _, name, found := strings.Cut(path, "/zoneinfo/"); found {
			if location, err := Load(name); err == nil {
				return location
			}
		}
	}
	if content, err := os.ReadFile("/etc/timezone"); err == nil {
		if location, err := Load(strings.TrimSpace(string(content))); err == nil {
			return location
		}
	}
	// Some distributions copy the zone file instead of retaining its IANA-name symlink.
	if content, err := os.ReadFile("/etc/localtime"); err == nil {
		var matched *time.Location
		_ = filepath.WalkDir("/usr/share/zoneinfo", func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			name := strings.TrimPrefix(path, "/usr/share/zoneinfo/")
			if strings.HasPrefix(name, "posix/") || strings.HasPrefix(name, "right/") {
				return nil
			}
			candidate, err := os.ReadFile(path)
			if err == nil && bytes.Equal(content, candidate) {
				if location, err := Load(name); err == nil {
					matched = location
					return filepath.SkipAll
				}
			}
			return nil
		})
		if matched != nil {
			return matched
		}
	}
	if location, err := Load(time.Local.String()); err == nil {
		return location
	}
	return time.Local
}

type Settings struct {
	server  *time.Location
	current atomic.Pointer[time.Location]
}

func New(server *time.Location) *Settings {
	settings := &Settings{server: server}
	settings.current.Store(server)
	return settings
}
func (s *Settings) Location() *time.Location { return s.current.Load() }
func (s *Settings) Server() *time.Location   { return s.server }
func (s *Settings) Resolve(name string) (*time.Location, error) {
	if name == "" {
		return s.server, nil
	}
	return Load(name)
}

// Apply publishes an already-resolved location; persistence callers resolve before
// committing so publication cannot fail after the database has accepted a setting.
func (s *Settings) Apply(location *time.Location) { s.current.Store(location) }

func (s *Settings) Set(name string) error {
	location, err := s.Resolve(name)
	if err != nil {
		return err
	}
	s.Apply(location)
	return nil
}

// Handler resolves the zone per record so a saved choice affects running services
// without mutating time.Local, which would race with unrelated time operations.
type Handler struct {
	slog.Handler
	Location func() *time.Location
}

func (h Handler) Handle(ctx context.Context, record slog.Record) error {
	record.Time = record.Time.In(h.Location())
	return h.Handler.Handle(ctx, record)
}
func (h Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return Handler{h.Handler.WithAttrs(attrs), h.Location}
}
func (h Handler) WithGroup(name string) slog.Handler {
	return Handler{h.Handler.WithGroup(name), h.Location}
}
