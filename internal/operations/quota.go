package operations

import (
	"context"
	"errors"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
)

// QuotaSubscription exposes only the account's plan reading, never provider
// response objects or credential metadata.
type QuotaSubscription struct {
	PlanType             string `json:"plan_type"`
	PlanLabel            string `json:"plan_label"`
	Tier                 string `json:"tier"`
	IsSubscriptionActive *bool  `json:"subscription_active,omitempty"`
}

type Quota struct {
	Plan           *QuotaSubscription        `json:"plan,omitempty"`
	AuthIndex      string                    `json:"auth_index"`
	Name           string                    `json:"name"`
	Provider       string                    `json:"provider"`
	Status         string                    `json:"status"`
	ObservedAtMS   int64                     `json:"observed_at_ms"`
	Windows        []quota.QuotaWindow       `json:"windows"`
	Recommendation quota.QuotaRecommendation `json:"recommendation"`
}

func SafeQuota(value *quota.NormalizedQuota) Quota {
	windows := value.Windows
	if windows == nil {
		windows = []quota.QuotaWindow{}
	}
	result := Quota{AuthIndex: value.AuthIndex, Name: safeLabel(value.Name), Provider: value.Provider, Status: value.Status, ObservedAtMS: value.ObservedAtMS, Windows: windows, Recommendation: value.Recommendation}
	if value.Plan != nil {
		result.Plan = &QuotaSubscription{PlanType: safeLabel(value.Plan.PlanType), PlanLabel: safeLabel(value.Plan.PlanLabel), Tier: value.Plan.Tier, IsSubscriptionActive: value.Plan.IsSubscriptionActive}
	}
	return result
}
func (s *Service) registerQuota(registry *capability.Registry) error {
	type Input struct {
		AuthIndex string `json:"auth_index,omitempty"`
	}
	type Output struct {
		Items []Quota `json:"items"`
	}
	if err := read(registry, "quota_list", "Read subscription plan labels and tiers, normalized quota windows, scoped capacity estimates and explicitly historical previous-cycle references. Missing or stale observations are not zero quota; estimates are not balances.", func(ctx context.Context, input Input) (Output, error) {
		items, err := s.Quotas(ctx)
		output := Output{Items: []Quota{}}
		for _, item := range items {
			if input.AuthIndex == "" || item.AuthIndex == input.AuthIndex {
				output.Items = append(output.Items, item)
			}
		}
		if len(output.Items) > 100 {
			return Output{}, errors.New("tool_result_too_large")
		}
		return output, err
	}); err != nil {
		return err
	}
	metadata := Meta("quota_refresh", "Refresh one credential's quota observation, subscription tier and scoped capacity estimate, with historical basis when applicable; does not reset or spend quota credits. Meta observes quota through its key-exchange endpoint, which may mint a key; returned keys are discarded.", "write", "low")
	metadata.Invalidates = []string{"management-quota"}
	return capability.Register(registry, metadata, nil, func(ctx context.Context, input struct {
		AuthIndex string `json:"auth_index"`
	}, _, _ string) (Quota, error) {
		if input.AuthIndex == "" {
			return Quota{}, errors.New("invalid_parameters")
		}
		return s.RefreshQuota(ctx, input.AuthIndex)
	})
}
