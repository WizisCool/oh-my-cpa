package repository

import (
	"context"
	"strings"
	"testing"
)

// The routing read runs on every live signal, so it must stay bounded by the
// window: a plan that walks the (instance, id) index filters every retained
// record whenever the minute holds fewer attempts than the limit.
func TestUsageRoutingReadSeeksTheTimeWindow(t *testing.T) {
	repo, _ := testRepository(t)
	rows, err := repo.SQL().QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+usageRoutingRecordsQuery,
		"default", 0, int64(1), int64(2), MAX_ROUTING_RECORDS+1)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(plan, "\n")
	if !strings.Contains(joined, "SEARCH e USING INDEX idx_usage_events_instance_time (instance_id=? AND timestamp_ms>?)") {
		t.Fatalf("the routing read does not seek the time window:\n%s", joined)
	}
}
