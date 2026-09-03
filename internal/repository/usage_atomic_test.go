package repository

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

func TestConcurrentAggregateUsageGrainIsAtomicAndExact(t *testing.T) {
	repo := usageTestRepository(t)
	ctx := context.Background()
	base := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)

	totalEvents := 100
	events := make([]usage.Event, totalEvents)
	var expectedTokens int64 = 0
	for i := 0; i < totalEvents; i++ {
		tokens := int64(10 + i)
		expectedTokens += tokens
		events[i] = usageEventAt("default", fmt.Sprintf("req-%d", i), base.Add(time.Duration(i)*time.Second), usage.TokenStats{
			InputTokens: tokens,
			TotalTokens: tokens,
		}, false)
	}

	if _, err := repo.InsertUsageEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	workers := 4
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for {
				absorbed, err := repo.AggregateUsageGrain(ctx, CheckpointHourly, HourBucketMS, 20)
				if err != nil {
					t.Errorf("concurrent aggregate error: %v", err)
					return
				}
				if absorbed == 0 {
					return
				}
			}
		}()
	}
	wg.Wait()

	var totalRequests, totalTokens int64
	err := repo.SQL().QueryRowContext(ctx, `
		SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(total_tokens), 0)
		FROM usage_overview_hourly_stats WHERE instance_id = 'default'`).Scan(&totalRequests, &totalTokens)
	if err != nil {
		t.Fatal(err)
	}

	if totalRequests != int64(totalEvents) {
		t.Fatalf("total aggregated requests = %d, want %d (double count detected)", totalRequests, totalEvents)
	}
	if totalTokens != expectedTokens {
		t.Fatalf("total aggregated tokens = %d, want %d", totalTokens, expectedTokens)
	}
}
