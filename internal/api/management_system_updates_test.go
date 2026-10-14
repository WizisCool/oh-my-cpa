package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
)

// storedRelease answers only the stored status; a check is a nil dereference, which is
// the assertion that this route never spends a feed request.
type storedRelease struct {
	ReleaseManager
	runningVersions map[string]string
}

func (s *storedRelease) Status(_ context.Context, product, runningVersion string) (release.ProductStatus, error) {
	s.runningVersions[product] = runningVersion
	return release.ProductStatus{
		Product:       product,
		LatestVersion: "v9.9.9",
		Comparison:    release.Comparison{State: release.UpdateAvailable, LatestVersion: "v9.9.9"},
	}, nil
}

func readSystemUpdates(t *testing.T, handler *Handler) SystemUpdatesDTO {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.getSystemUpdates(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/updates", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var dto SystemUpdatesDTO
	if err := json.Unmarshal(recorder.Body.Bytes(), &dto); err != nil {
		t.Fatal(err)
	}
	return dto
}

// The shell reads this route on every page, so a deployment without release checking
// answers "not checked yet" rather than an error the console would report.
func TestSystemUpdatesAnswersNotCheckedWithoutAReleaseService(t *testing.T) {
	dto := readSystemUpdates(t, &Handler{})
	for _, version := range []SystemProductVersionDTO{dto.OMCVersion, dto.CPAVersion} {
		if version.State != release.UpdateIndeterminate || version.Reason != release.ReasonNoData {
			t.Errorf("%s = %q/%q, want indeterminate/not checked", version.Product, version.State, version.Reason)
		}
	}
}

func TestSystemUpdatesReportsTheStoredAnswerForBothProducts(t *testing.T) {
	manager := &storedRelease{runningVersions: map[string]string{}}
	handler := &Handler{cfg: config.Config{Version: "v1.2.3"}, release: manager}
	dto := readSystemUpdates(t, handler)
	for _, version := range []SystemProductVersionDTO{dto.OMCVersion, dto.CPAVersion} {
		if version.State != release.UpdateAvailable || version.LatestVersion != "v9.9.9" {
			t.Errorf("%s = %q latest %q, want an available v9.9.9", version.Product, version.State, version.LatestVersion)
		}
	}
	if dto.OMCVersion.Product != release.ProductOMC || dto.CPAVersion.Product != release.ProductCPA {
		t.Errorf("products = %q, %q", dto.OMCVersion.Product, dto.CPAVersion.Product)
	}
	if manager.runningVersions[release.ProductOMC] != "v1.2.3" {
		t.Errorf("OMC compared against %q, want the build version", manager.runningVersions[release.ProductOMC])
	}
}
