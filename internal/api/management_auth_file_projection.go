package api

import (
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func projectManagementAuthFile(file management.AuthFile) managementAuthFileResponse {
	result := managementAuthFileResponse{
		Name:          boundedText(firstNonEmpty(file.Name, file.ID), managementAuthFileNameLimit),
		AuthIndex:     boundedText(file.AuthIndex, managementAuthFileNameLimit),
		Type:          boundedText(firstNonEmpty(file.Type, file.Provider), managementAuthFileFieldLimit),
		Provider:      boundedText(file.Provider, managementAuthFileFieldLimit),
		Status:        boundedText(file.Status, managementAuthFileFieldLimit),
		StatusMessage: boundedText(file.StatusMessage, managementAuthFileFieldLimit),
		Disabled:      file.Disabled,
		Unavailable:   file.Unavailable,
		RuntimeOnly:   file.RuntimeOnly,
		Email:         boundedText(file.Email, managementAuthFileFieldLimit),
		ProjectID:     boundedText(file.ProjectID, managementAuthFileFieldLimit),
		Success:       nonNegative(file.Success),
		Failed:        nonNegative(file.Failed),
		Priority:      file.Priority,
		Weight:        file.Weight,
		Note:          boundedText(file.Note, managementAuthFileFieldLimit),
		Models:        projectAuthModels(file.Models),
		Quota:         projectQuota(file.Quota),
		ModelQuotas:   projectModelQuotas(file.ModelQuotas),
	}
	for _, bucket := range file.RecentRequests {
		if len(result.RecentRequests) >= managementOverviewBucketCount {
			break
		}
		result.RecentRequests = append(result.RecentRequests, managementAuthFileRequestBucket{
			Time:    boundedText(bucket.Time, managementAuthFileFieldLimit),
			Success: nonNegative(bucket.Success),
			Failed:  nonNegative(bucket.Failed),
		})
	}
	return result
}

func projectAuthModels(models []management.AuthModel) []managementAuthFileModel {
	result := make([]managementAuthFileModel, 0, len(models))
	for _, model := range models {
		id := boundedText(model.ID, managementAuthFileFieldLimit)
		if id == "" {
			continue
		}
		result = append(result, managementAuthFileModel{ID: id, DisplayName: boundedText(model.DisplayName, managementAuthFileFieldLimit)})
		if len(result) >= managementOverviewBucketCount*managementOverviewBucketCount {
			break
		}
	}
	return result
}

func projectQuota(raw map[string]any) *managementQuotaObservation {
	if len(raw) == 0 {
		return nil
	}
	result := &managementQuotaObservation{Signals: map[string]string{}}
	if value, ok := raw["observed_at"]; ok {
		result.ObservedAt = boundedText(fmt.Sprint(value), managementAuthFileFieldLimit)
	}
	if signals, ok := raw["signals"].(map[string]any); ok {
		for key, value := range signals {
			if len(result.Signals) >= 64 {
				break
			}
			key = boundedText(key, 128)
			if key == "" {
				continue
			}
			result.Signals[key] = boundedText(fmt.Sprint(value), managementAuthFileFieldLimit)
		}
	}
	if result.ObservedAt == "" && len(result.Signals) == 0 {
		return nil
	}
	if len(result.Signals) == 0 {
		result.Signals = nil
	}
	return result
}

func projectModelQuotas(raw map[string]map[string]any) map[string]managementQuotaObservation {
	if len(raw) == 0 {
		return nil
	}
	result := make(map[string]managementQuotaObservation)
	for model, value := range raw {
		model = boundedText(model, managementAuthFileFieldLimit)
		if model == "" {
			continue
		}
		if quota := projectQuota(value); quota != nil {
			result[model] = *quota
		}
		if len(result) >= managementOverviewBucketCount*managementOverviewBucketCount {
			break
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}
