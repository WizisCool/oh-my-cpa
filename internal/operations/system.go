package operations

import (
	"context"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
)

func (s *Service) registerSystem(registry *capability.Registry) error {
	type Plugin struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Version   string `json:"version"`
		IsEnabled bool   `json:"is_enabled"`
	}
	type Plugins struct {
		Items []Plugin `json:"items"`
	}
	if err := read(registry, "plugins_list", "Read plugin status only; installation, execution and configuration are not exposed.", func(ctx context.Context, _ Empty) (Plugins, error) {
		client, err := s.Client(ctx)
		if err != nil {
			return Plugins{}, err
		}
		items, err := client.Plugins(ctx)
		result := Plugins{Items: []Plugin{}}
		for _, item := range items {
			result.Items = append(result.Items, Plugin{safeLabel(item.ID), safeLabel(item.Name), safeLabel(item.Version), item.Enabled})
		}
		return result, err
	}); err != nil {
		return err
	}
	type Audit struct {
		Action       string `json:"action"`
		Result       string `json:"result"`
		OccurredAtMS int64  `json:"occurred_at_ms"`
	}
	type Audits struct {
		Items []Audit `json:"items"`
	}
	if err := read(registry, "audit_list", "Read the latest 50 audit outcome summaries, excluding details and source identity.", func(ctx context.Context, _ Empty) (Audits, error) {
		events, err := s.Repo.ListAuditEvents(ctx, 50)
		result := Audits{Items: []Audit{}}
		for _, event := range events {
			result.Items = append(result.Items, Audit{event.Action, event.Result, event.OccurredAtMS})
		}
		return result, err
	}); err != nil {
		return err
	}
	return read(registry, "system_health", "Check the OMC database connection without disclosing host configuration.", func(ctx context.Context, _ Empty) (struct {
		IsHealthy bool `json:"is_healthy"`
	}, error) {
		err := s.Repo.SQL().PingContext(ctx)
		return struct {
			IsHealthy bool `json:"is_healthy"`
		}{err == nil}, err
	})
}
