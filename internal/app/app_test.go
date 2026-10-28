package app

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
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
