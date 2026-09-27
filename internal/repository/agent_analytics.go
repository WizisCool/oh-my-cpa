package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type UsageGroup struct {
	Key            string `json:"key"`
	Requests       int64  `json:"requests"`
	Failures       int64  `json:"failures"`
	Tokens         int64  `json:"tokens"`
	Input          int64  `json:"input_tokens"`
	Output         int64  `json:"output_tokens"`
	CostNanos      int64  `json:"cost_nanos"`
	PricedRequests int64  `json:"priced_requests"`
}
type UsageAggregation struct {
	Groups  []UsageGroup `json:"groups"`
	Total   UsageGroup   `json:"total"`
	HasMore bool         `json:"has_more"`
	Other   *UsageGroup  `json:"other,omitempty"`
}

// AggregateUsage reuses the explorer predicate. Only enumerated dimensions can enter SQL.
func (r *Repository) AggregateUsage(ctx context.Context, filter UsageEventFilter, group string, bucketMS int64) (UsageAggregation, error) {
	dimensions := map[string]string{"provider": "COALESCE(NULLIF(e.provider,''),'unknown')", "model": "e.model", "call_point": "COALESCE(NULLIF(e.model_alias,''),e.model)", "client_key": "e.api_group_key", "credential": "e.auth_index", "status": "CASE WHEN e.failed=1 THEN 'failed' ELSE 'success' END", "all": "'all'"}
	expression, ok := dimensions[group]
	if !ok {
		return UsageAggregation{}, errors.New("invalid_parameters")
	}
	if bucketMS > 0 {
		expression = fmt.Sprintf("CAST((e.timestamp_ms / %d) * %d AS TEXT)", bucketMS, bucketMS)
	}
	where, args, err := usageEventWhere(filter)
	if err != nil {
		return UsageAggregation{}, err
	}
	// Window totals preserve the contribution outside the bounded top groups.
	query := `WITH grouped AS (SELECT ` + expression + ` AS group_key, COUNT(*) AS requests, COALESCE(SUM(e.failed),0) AS failures, COALESCE(SUM(e.total_tokens),0) AS tokens, COALESCE(SUM(e.input_tokens),0) AS input_tokens, COALESCE(SUM(e.output_tokens),0) AS output_tokens, COALESCE(SUM(e.cost_nanos),0) AS cost_nanos, COUNT(e.cost_nanos) AS priced FROM usage_events e WHERE ` + strings.Join(where, " AND ") + ` GROUP BY group_key) SELECT group_key,requests,failures,tokens,input_tokens,output_tokens,cost_nanos,priced,SUM(requests) OVER(),SUM(failures) OVER(),SUM(tokens) OVER(),SUM(input_tokens) OVER(),SUM(output_tokens) OVER(),SUM(cost_nanos) OVER(),SUM(priced) OVER(),COUNT(*) OVER() FROM grouped ORDER BY requests DESC,group_key LIMIT 50`
	if bucketMS > 0 {
		query = strings.Replace(query, "ORDER BY requests DESC,group_key LIMIT 50", "ORDER BY CAST(group_key AS INTEGER) LIMIT 120", 1)
	}
	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return UsageAggregation{}, err
	}
	defer rows.Close()
	result := UsageAggregation{Groups: []UsageGroup{}, Total: UsageGroup{Key: "all"}}
	var count int
	for rows.Next() {
		var row UsageGroup
		if err := rows.Scan(&row.Key, &row.Requests, &row.Failures, &row.Tokens, &row.Input, &row.Output, &row.CostNanos, &row.PricedRequests, &result.Total.Requests, &result.Total.Failures, &result.Total.Tokens, &result.Total.Input, &result.Total.Output, &result.Total.CostNanos, &result.Total.PricedRequests, &count); err != nil {
			return result, err
		}
		result.Groups = append(result.Groups, row)
	}
	result.HasMore = count > len(result.Groups)
	if result.HasMore {
		other := result.Total
		other.Key = "other"
		for _, row := range result.Groups {
			other.Requests -= row.Requests
			other.Failures -= row.Failures
			other.Tokens -= row.Tokens
			other.Input -= row.Input
			other.Output -= row.Output
			other.CostNanos -= row.CostNanos
			other.PricedRequests -= row.PricedRequests
		}
		result.Other = &other
	}
	return result, rows.Err()
}
