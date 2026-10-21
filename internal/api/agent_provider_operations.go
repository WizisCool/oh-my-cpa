package api

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

func (h *Handler) bindProviderOperations(service *operations.Service) {
	check := func(id, revision string) func(context.Context) error {
		return func(ctx context.Context) error {
			current, err := service.FindProvider(ctx, id)
			if err != nil {
				return err
			}
			if revision == "" || current.Revision != revision {
				return errors.New("resource_conflict")
			}
			return nil
		}
	}
	// The executor owns the durable capability audit. Ordinary HTTP calls supply their own audit callback.
	audited := func(string, string, string, string, map[string]any) error { return nil }
	service.SaveProvider = func(ctx context.Context, input operations.ProviderMutation, revision, secret string) (operations.ProviderMutationResult, error) {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return operations.ProviderMutationResult{}, err
		}
		req := SaveProviderRequest{Family: input.Family, APIKey: secret}
		if input.ID != "" {
			found := false
			for _, item := range h.readProviderItems(ctx, client) {
				if item.ID == input.ID {
					raw, _ := json.Marshal(item)
					observed, _ := h.cipher.Fingerprint("provider-operation", string(raw))
					if observed != revision {
						return operations.ProviderMutationResult{}, errors.New("resource_conflict")
					}
					found = true
					req = SaveProviderRequest{Family: item.Family, Name: item.UpstreamName, BaseURL: item.BaseURL, Prefix: item.Prefix, Priority: item.Priority, DisableCooling: item.DisableCooling, Disabled: item.Disabled, APIKey: item.APIKey, Headers: item.Headers}
					if req.Name == "" {
						req.Name = item.Name
					}
					for _, key := range item.KeyEntries {
						req.Keys = append(req.Keys, SaveProviderKeyEntry{APIKey: key.APIKey, ProxyURL: key.ProxyURL, Weight: key.Weight})
					}
					for _, model := range item.ModelEntries {
						req.ModelEntries = append(req.ModelEntries, SaveProviderModelEntry(model))
					}
					break
				}
			}
			if !found {
				return operations.ProviderMutationResult{}, errors.New("resource_missing")
			}
			ctx = context.WithValue(ctx, providerPreconditionKey{}, check(input.ID, revision))
		}
		if input.Name != nil {
			req.Name = *input.Name
		}
		if input.BaseURL != nil {
			req.BaseURL = *input.BaseURL
		}
		if input.Prefix != nil {
			req.Prefix = *input.Prefix
		}
		if input.Priority != nil {
			req.Priority = input.Priority
		}
		if input.OpenAPI != "" || input.OpenAPILocation != nil {
			if req.Family != "vertex" {
				return operations.ProviderMutationResult{}, errors.New("invalid_parameters")
			}
			req.Behavior = &ProviderBehaviorDTO{OpenAPI: input.OpenAPI, OpenAPILocation: input.OpenAPILocation}
		}
		if input.Models != nil {
			storedModels := req.ModelEntries
			storedRoutes := make([]management.ModelAlias, len(storedModels))
			requestedRoutes := make([]management.ModelAlias, len(*input.Models))
			for index, model := range storedModels {
				storedRoutes[index] = management.ModelAlias{Name: model.Name, Alias: model.Alias}
			}
			for index, model := range *input.Models {
				requestedRoutes[index] = management.ModelAlias{Name: model.Name, Alias: model.Alias}
			}
			matches, err := matchProviderModelRoutes(storedRoutes, requestedRoutes)
			if err != nil {
				return operations.ProviderMutationResult{}, errors.New("invalid_parameters")
			}
			req.ModelEntries = []SaveProviderModelEntry{}
			for position, model := range *input.Models {
				entry := SaveProviderModelEntry{Name: model.Name, Alias: model.Alias}
				var matched *SaveProviderModelEntry
				if matches[position] >= 0 {
					matched = &storedModels[matches[position]]
					entry.Thinking, entry.Image = matched.Thinking, matched.Image
				}
				if model.OpenAPI != "" {
					if req.Family != "vertex" {
						return operations.ProviderMutationResult{}, errors.New("invalid_parameters")
					}
					options := ProviderModelOptionsDTO{}
					if matched != nil && matched.Options != nil {
						options = *matched.Options
					}
					options.OpenAPI = openAPIOverrideValue(model.OpenAPI)
					entry.Options = &options
				}
				req.ModelEntries = append(req.ModelEntries, entry)
			}
		}
		if input.Models == nil {
			// An unrelated provider edit must not restate or revalidate advanced model options.
			for index := range req.ModelEntries {
				req.ModelEntries[index].Options = nil
			}
		}
		var output map[string]any
		if input.ID == "" {
			output, err = h.createProvider(ctx, client, req, audited)
		} else {
			output, err = h.updateProvider(ctx, client, input.ID, req, audited)
		}
		if err != nil {
			return operations.ProviderMutationResult{}, mapAgentProviderError(err)
		}
		id, _ := output["id"].(string)
		return operations.ProviderMutationResult{ID: id}, nil
	}
	service.DeleteProvider = func(ctx context.Context, id, revision string) error {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return err
		}
		ctx = context.WithValue(ctx, providerPreconditionKey{}, check(id, revision))
		_, err = h.deleteProvider(ctx, client, id, audited)
		return mapAgentProviderError(err)
	}
	service.RenameProvider = func(ctx context.Context, id, name, revision string) error {
		if err := h.providerWrites.acquire(ctx); err != nil {
			return errors.New("write_busy")
		}
		defer h.providerWrites.release()
		if err := check(id, revision)(ctx); err != nil {
			return err
		}
		return h.applyProviderMetadata(ctx, id, name, "", false)
	}
}
func mapAgentProviderError(err error) error {
	if err == nil {
		return nil
	}
	var partial *providerPartialCommitError
	if errors.As(err, &partial) {
		return errors.New("provider_commit_partial")
	}
	if errors.Is(err, errProviderWriteBusy) {
		return errors.New("write_busy")
	}
	if capability.ErrorCode(err) != "operation_failed" {
		return err
	}
	return errors.New("operation_outcome_unknown")
}
