package release

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// stargazerFeed is a feed source that also answers the star count, counting the reads.
type stargazerFeed struct {
	feedSourceFunc
	count atomic.Int64
	fail  atomic.Bool
	reads atomic.Int64
}

func (f *stargazerFeed) FetchStargazers(_ context.Context, repository string) (int64, error) {
	f.reads.Add(1)
	if repository != ProjectRepository {
		return 0, errors.New("unexpected repository " + repository)
	}
	if f.fail.Load() {
		return 0, errors.New("offline")
	}
	return f.count.Load(), nil
}

func newStargazerService(t *testing.T, source FeedSource) *Service {
	t.Helper()
	service, _ := newTestService(t, func(http.ResponseWriter, *http.Request) {
		t.Error("the stub GitHub API must not be reached")
	})
	service.client = source
	return service
}

func emptyFeed(_ context.Context, repository, _ string) (Feed, error) {
	return Feed{Repository: repository}, nil
}

func TestFetchStargazersReadsTheRepositoryDocument(t *testing.T) {
	var path string
	service, _ := newTestService(t, func(writer http.ResponseWriter, request *http.Request) {
		path = request.URL.Path
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"full_name":"WizisCool/oh-my-cpa","stargazers_count":1234}`))
	})
	count, err := service.client.(StargazerSource).FetchStargazers(context.Background(), ProjectRepository)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1234 {
		t.Errorf("count = %d, want 1234", count)
	}
	if path != "/repos/"+ProjectRepository {
		t.Errorf("request path = %q", path)
	}
}

// A document without the field is not a repository with no stars, and a refused or
// malformed read must not become a zero the header would show.
func TestFetchStargazersRefusesAnAnswerWithoutACount(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"missing field": func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write([]byte(`{}`)) },
		"negative":      func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write([]byte(`{"stargazers_count":-1}`)) },
		"not json":      func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write([]byte(`<html>`)) },
		"not found":     func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusNotFound) },
	}
	for name, handler := range cases {
		t.Run(name, func(t *testing.T) {
			service, _ := newTestService(t, handler)
			if _, err := service.client.(StargazerSource).FetchStargazers(context.Background(), ProjectRepository); err == nil {
				t.Fatal("an answer without a count was accepted")
			}
		})
	}
	t.Run("rate limited", func(t *testing.T) {
		service, _ := newTestService(t, func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("X-RateLimit-Limit", "60")
			writer.Header().Set("X-RateLimit-Remaining", "0")
			writer.WriteHeader(http.StatusForbidden)
		})
		_, err := service.client.(StargazerSource).FetchStargazers(context.Background(), ProjectRepository)
		if !errors.Is(err, ErrRateLimited) {
			t.Fatalf("error = %v, want ErrRateLimited", err)
		}
	})
}

// The header is mounted on every page, so the floor is what keeps a console that is
// being browsed from spending the shared budget one request per page view.
func TestStargazersSpendsOneReadPerFloor(t *testing.T) {
	source := &stargazerFeed{feedSourceFunc: emptyFeed}
	source.count.Store(1234)
	service := newStargazerService(t, source)
	ctx := context.Background()

	if _, isKnown := service.Stargazers(ctx, false); isKnown || source.reads.Load() != 0 {
		t.Fatalf("a read without permission spent a request or invented a count (reads %d)", source.reads.Load())
	}
	for range 3 {
		count, isKnown := service.Stargazers(ctx, true)
		if !isKnown || count != 1234 {
			t.Fatalf("count = %d known = %v, want 1234", count, isKnown)
		}
	}
	if reads := source.reads.Load(); reads != 1 {
		t.Fatalf("reads inside the floor = %d, want 1", reads)
	}

	source.count.Store(1300)
	service.stargazers.attemptedAt = time.Now().Add(-StargazerFloor - time.Second)
	if count, _ := service.Stargazers(ctx, false); count != 1234 || source.reads.Load() != 1 {
		t.Fatalf("a read without permission refreshed past the floor (count %d)", count)
	}
	if count, _ := service.Stargazers(ctx, true); count != 1300 {
		t.Fatalf("count after the floor = %d, want 1300", count)
	}
}

// A failure is an attempt: it keeps the last count and is not retried inside the floor.
func TestStargazersKeepsTheLastCountWhenARefreshFails(t *testing.T) {
	source := &stargazerFeed{feedSourceFunc: emptyFeed}
	source.count.Store(42)
	service := newStargazerService(t, source)
	ctx := context.Background()
	service.Stargazers(ctx, true)

	source.fail.Store(true)
	service.stargazers.attemptedAt = time.Now().Add(-StargazerFloor - time.Second)
	for range 2 {
		if count, isKnown := service.Stargazers(ctx, true); !isKnown || count != 42 {
			t.Fatalf("count = %d known = %v after a failed refresh, want the previous 42", count, isKnown)
		}
	}
	if reads := source.reads.Load(); reads != 2 {
		t.Fatalf("reads = %d, want 2: the failed attempt must hold the floor", reads)
	}
}

func TestStargazersIsUnknownForASourceThatCannotCount(t *testing.T) {
	service := newStargazerService(t, feedSourceFunc(emptyFeed))
	if _, isKnown := service.Stargazers(context.Background(), true); isKnown {
		t.Fatal("a source without star counts produced one")
	}
}

func TestTheSweepRefreshesTheStarCount(t *testing.T) {
	source := &stargazerFeed{feedSourceFunc: emptyFeed}
	source.count.Store(7)
	service := newStargazerService(t, source)
	service.CheckAll(context.Background())
	if count, isKnown := service.Stargazers(context.Background(), false); !isKnown || count != 7 {
		t.Fatalf("count after a sweep = %d known = %v, want 7", count, isKnown)
	}
}
