package app

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
)

// TestRetentionRunsWithCaptureOff pins that switching capture off does not switch
// retention off. A deployment that collects usage elsewhere still holds the records
// it captured before; they used to stay forever because maintenance was built only
// as part of the capture pipeline.
func TestRetentionRunsWithCaptureOff(t *testing.T) {
	t.Setenv("OMCPA_MASTER_KEY", "app-test-master-key-0123456789abcdef")
	t.Setenv("OMCPA_DATA_DIR", t.TempDir())
	t.Setenv("OMCPA_USAGE_INGEST_MODE", "off")
	t.Setenv("OMCPA_UPDATE_CHECK_ENABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DatabasePath = filepath.Join(cfg.DataDir, "app.db")
	application, err := New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = application.Close() })
	if application.pipeline != nil {
		t.Fatal("capture is off, yet a capture pipeline was built")
	}
	if application.usageMaintenance == nil {
		t.Fatal("capture is off and nothing will apply retention to the records already stored")
	}
}

func TestRunReportsProcessListenAddressConflictWithoutLoggingListening(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = occupied.Close() })

	t.Setenv("OMCPA_MASTER_KEY", "app-test-master-key-0123456789abcdef")
	t.Setenv("OMCPA_DATA_DIR", t.TempDir())
	t.Setenv("OMCPA_LISTEN_ADDR", occupied.Addr().String())
	t.Setenv("OMCPA_USAGE_INGEST_MODE", "off")
	t.Setenv("OMCPA_UPDATE_CHECK_ENABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	var logBuffer bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuffer, nil))
	application, err := New(context.Background(), cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = application.Close() })

	runErr := application.Run(context.Background())
	if runErr == nil {
		t.Fatal("expected listen conflict error")
	}
	if !strings.Contains(runErr.Error(), "OMCPA_LISTEN_ADDR") {
		t.Fatalf("listen conflict error must name OMCPA_LISTEN_ADDR, got: %v", runErr)
	}
	if strings.Contains(runErr.Error(), "OMCPA_BIND") {
		t.Fatalf("process listen error must not name Compose host variable OMCPA_BIND, got: %v", runErr)
	}
	if strings.Contains(logBuffer.String(), "HTTP server listening") {
		t.Fatalf("server logged that it was listening before socket bind succeeded:\n%s", logBuffer.String())
	}
}

func TestNewReportsUnwritableDataDirectoryWithProcessIdentity(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses 0500 directory permissions")
	}
	readOnlyDir := filepath.Join(t.TempDir(), "readonly-data")
	if err := os.MkdirAll(readOnlyDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnlyDir, 0o700) })

	t.Setenv("OMCPA_MASTER_KEY", "app-test-master-key-0123456789abcdef")
	t.Setenv("OMCPA_DATA_DIR", readOnlyDir)
	t.Setenv("OMCPA_USAGE_INGEST_MODE", "off")
	t.Setenv("OMCPA_UPDATE_CHECK_ENABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	_, err = New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("expected permission error on unwritable data directory")
	}
	wantIdentity := fmt.Sprintf("uid:gid %d:%d", os.Geteuid(), os.Getegid())
	if !strings.Contains(err.Error(), readOnlyDir) || !strings.Contains(err.Error(), wantIdentity) {
		t.Fatalf("permission error must name directory %q and %q, got: %v", readOnlyDir, wantIdentity, err)
	}
}
