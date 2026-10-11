package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
)

// stargazerRelease answers only the star count; any other call is a nil dereference,
// which is the assertion that this route reads nothing else.
type stargazerRelease struct {
	ReleaseManager
	count      int64
	isKnown    bool
	mayFetches []bool
}

func (s *stargazerRelease) Stargazers(_ context.Context, mayFetch bool) (int64, bool) {
	s.mayFetches = append(s.mayFetches, mayFetch)
	return s.count, s.isKnown
}

func readSystemRepository(t *testing.T, handler *Handler) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.getSystemRepository(recorder, httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/system/repository", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	return strings.TrimSpace(recorder.Body.String())
}

// The shell reads this route on every page, so every way of not knowing the count is a
// successful null rather than an error the console would report.
func TestSystemRepositoryAnswersNullWhenTheCountIsUnknown(t *testing.T) {
	if body := readSystemRepository(t, &Handler{}); body != `{"stargazers_count":null}` {
		t.Errorf("without a release service: %s", body)
	}
	if body := readSystemRepository(t, &Handler{release: &stargazerRelease{}}); body != `{"stargazers_count":null}` {
		t.Errorf("before a successful read: %s", body)
	}
}

// A page visit may spend the read only where the operator lets page visits check.
func TestSystemRepositoryFetchesOnlyWhenPageLoadChecksAreAllowed(t *testing.T) {
	for _, autoCheck := range []bool{false, true} {
		manager := &stargazerRelease{count: 1234, isKnown: true}
		handler := &Handler{cfg: config.Config{Release: config.ReleaseConfig{AutoCheck: autoCheck}}, release: manager}
		if body := readSystemRepository(t, handler); body != `{"stargazers_count":1234}` {
			t.Errorf("auto check %v: %s", autoCheck, body)
		}
		if len(manager.mayFetches) != 1 || manager.mayFetches[0] != autoCheck {
			t.Errorf("auto check %v: fetch permission = %v", autoCheck, manager.mayFetches)
		}
	}
}
