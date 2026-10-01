package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"reflect"
	"strings"
	"testing"
)

// The independent grouped queries are the equivalence oracle for the combined read.
func readFacetsIndividually(r *Repository, ctx context.Context, instanceID string, fromMS, toMS int64) (UsageFacets, error) {
	facets := UsageFacets{
		Models:           []UsageFacetValue{},
		Providers:        []UsageFacetValue{},
		APIGroupKey:      []UsageFacetValue{},
		AuthIndexes:      []UsageFacetValue{},
		Sources:          []UsageFacetValue{},
		Executors:        []UsageFacetValue{},
		ModelAliases:     []UsageFacetValue{},
		AuthTypes:        []UsageFacetValue{},
		ReasoningEfforts: []UsageFacetValue{},
		ServiceTiers:     []UsageFacetValue{},
	}
	if r == nil || r.SQL() == nil {
		return facets, errors.New("repository is not initialized")
	}
	columns := []struct {
		column     string
		maskColumn string
		target     *[]UsageFacetValue
	}{
		{column: "model", target: &facets.Models},
		{column: "provider", target: &facets.Providers},
		// The api_group_keys facet is the caller-key list, so it carries the
		// display mask. The mask is deterministic per key, so any non-empty mask
		// in the group labels the whole group.
		{column: "api_group_key", maskColumn: "api_key_mask", target: &facets.APIGroupKey},
		{column: "auth_index", target: &facets.AuthIndexes},
		{column: "source", target: &facets.Sources},
		{column: "executor_type", target: &facets.Executors},
		{column: "model_alias", target: &facets.ModelAliases},
		{column: "auth_type", target: &facets.AuthTypes},
		{column: "reasoning_effort", target: &facets.ReasoningEfforts},
		{column: "service_tier", target: &facets.ServiceTiers},
	}
	for _, entry := range columns {
		if strings.TrimSpace(entry.column) == "" {
			continue
		}
		maskExpression := "''"
		if entry.maskColumn != "" {
			maskExpression = `COALESCE(MAX(NULLIF(` + entry.maskColumn + `, '')), '')`
		}
		rows, err := r.SQL().QueryContext(ctx, `
			SELECT `+entry.column+`, COUNT(1), `+maskExpression+`
			FROM usage_events
			WHERE instance_id = ? AND timestamp_ms BETWEEN ? AND ? AND `+entry.column+` <> ''
			GROUP BY `+entry.column+`
			ORDER BY COUNT(1) DESC, `+entry.column+` ASC
			LIMIT 200`, instanceID, fromMS, toMS)
		if err != nil {
			return facets, fmt.Errorf("read usage facets %s: %w", entry.column, err)
		}
		values := []UsageFacetValue{}
		for rows.Next() {
			var value UsageFacetValue
			if errScan := rows.Scan(&value.Value, &value.Requests, &value.Mask); errScan != nil {
				rows.Close()
				return facets, fmt.Errorf("scan usage facet %s: %w", entry.column, errScan)
			}
			// Facet masks are stored values too, so legacy rows are converted here
			// as well; the list and detail views do the same in the API projection.
			value.Mask = security.NormalizeMask(value.Mask)
			values = append(values, value)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return facets, err
		}
		rows.Close()
		*entry.target = values
	}
	return facets, nil
}

func seedFacetDimensions(tb testing.TB, repo *Repository, cardinality int) {
	tb.Helper()
	_, err := repo.SQL().Exec(`UPDATE usage_events SET
 model = 'model-' || (id % ?), provider = 'provider-' || (id % 7),
 api_group_key = 'key-' || (id % ?), api_key_mask = CASE WHEN id % 3 = 0 THEN '' ELSE 'sk-****' || (id % 11) END,
 auth_index = 'auth-' || (id % ?), source = 'source-' || (id % ?),
 executor_type = CASE WHEN id % 2 = 0 THEN '' ELSE 'executor' END,
 model_alias = 'alias-' || (id % ?), auth_type = 'type-' || (id % 3),
 reasoning_effort = CASE WHEN id % 3 = 0 THEN '' ELSE 'high' END,
 service_tier = CASE WHEN id % 2 = 0 THEN 'default' ELSE 'priority' END`,
		cardinality, cardinality, cardinality, cardinality, cardinality)
	if err != nil {
		tb.Fatal(err)
	}
}

func TestUsageFacetsEquivalent(t *testing.T) {
	repo := performanceRepository(t, 1234)
	seedFacetDimensions(t, repo, 257)
	// Binary ordering, whitespace, empty values, and legacy mask fillers must retain their meanings.
	_, err := repo.SQL().Exec(`UPDATE usage_events SET model = CASE id % 7
 WHEN 0 THEN '' WHEN 1 THEN ' ' WHEN 2 THEN 'Alpha' WHEN 3 THEN 'alpha' WHEN 4 THEN '中文' ELSE model END`)
	if err != nil {
		t.Fatal(err)
	}
	for _, window := range []struct {
		name, instance string
		from, to       int64
	}{
		{"all", "default", 1700000000000, 1700100000000},
		{"inclusive", "default", 1700000000001, 1700000000001},
		{"partial", "default", 1700000000042, 1700000000823},
		{"empty", "default", 0, 1},
		{"other instance", "missing", 1700000000000, 1700100000000},
		{"reversed", "default", 1700100000000, 1700000000000},
	} {
		t.Run(window.name, func(t *testing.T) {
			want, err := readFacetsIndividually(repo, context.Background(), window.instance, window.from, window.to)
			if err != nil {
				t.Fatal(err)
			}
			got, err := repo.GetUsageFacets(context.Background(), window.instance, window.from, window.to)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("facets differ\ngot: %+v\nwant: %+v", got, want)
			}
			if len(got.AuthIndexes) > 200 {
				t.Fatal("facet cap exceeded")
			}
		})
	}
}

func TestUsageFacetsBoundaryAndMask(t *testing.T) {
	repo := performanceRepository(t, 3)
	_, err := repo.SQL().Exec(`UPDATE usage_events SET model = CASE id WHEN 1 THEN 'z' ELSE 'a' END,
 api_key_mask = CASE id WHEN 1 THEN 'sk-****1' WHEN 2 THEN '' ELSE 'sk-****9' END`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := repo.GetUsageFacets(context.Background(), "default", 1700000000001, 1700000000003)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Models, []UsageFacetValue{{Value: "a", Requests: 2}, {Value: "z", Requests: 1}}) {
		t.Fatalf("count ordering: %+v", got.Models)
	}
	if !reflect.DeepEqual(got.APIGroupKey, []UsageFacetValue{{Value: "group", Requests: 3, Mask: security.NormalizeMask("sk-****9")}}) {
		t.Fatalf("mask max/normalization: %+v", got.APIGroupKey)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := repo.GetUsageFacets(ctx, "default", 0, 1700100000000); err == nil {
		t.Fatal("canceled read succeeded")
	}
	var missing *Repository
	if _, err := missing.GetUsageFacets(context.Background(), "default", 0, 1); err == nil {
		t.Fatal("uninitialized read succeeded")
	}
}

func BenchmarkUsageFacetsStrategies(b *testing.B) {
	for _, cardinality := range []int{20, 10000} {
		b.Run(fmt.Sprintf("cardinality-%d", cardinality), func(b *testing.B) {
			repo := performanceRepository(b, 100000)
			seedFacetDimensions(b, repo, cardinality)
			for _, strategy := range []struct {
				name string
				read func(*Repository, context.Context, string, int64, int64) (UsageFacets, error)
			}{
				{"grouped", readFacetsIndividually}, {"materialized", (*Repository).GetUsageFacets},
			} {
				b.Run(strategy.name, func(b *testing.B) {
					b.ReportAllocs()
					for i := 0; i < b.N; i++ {
						if _, err := strategy.read(repo, context.Background(), "default", 1700000000000, 1700100000000); err != nil {
							b.Fatal(err)
						}
					}
				})
			}
		})
	}
}

func BenchmarkUsageFacetsNarrowWindow(b *testing.B) {
	repo := performanceRepository(b, 100000)
	seedFacetDimensions(b, repo, 10000)
	for _, strategy := range []struct {
		name string
		read func(*Repository, context.Context, string, int64, int64) (UsageFacets, error)
	}{
		{"grouped", readFacetsIndividually}, {"materialized", (*Repository).GetUsageFacets},
	} {
		b.Run(strategy.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := strategy.read(repo, context.Background(), "default", 1700000000000, 1700000001000); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
