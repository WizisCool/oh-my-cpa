package api

import (
	"context"
	"net/http"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// The openai-compatibility append helper builds the new entry against the list as it
// exists inside the write window, so an append cannot be based on a stale length.
func (h *Handler) appendOpenAICompatibilityGated(
	ctx context.Context,
	client *management.Client,
	entry management.OpenAICompatibility,
	afterUpdate func(context.Context, []management.OpenAICompatibility),
) ([]management.OpenAICompatibility, error) {
	var updated []management.OpenAICompatibility
	err := gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.OpenAICompatibility, error) {
			resp, err := client.OpenAICompatibility(ctx)
			if err != nil {
				return nil, err
			}
			return resp.Entries, nil
		},
		func(ctx context.Context, list []management.OpenAICompatibility) error {
			return client.UpdateOpenAICompatibility(ctx, list)
		},
		func(list *[]management.OpenAICompatibility) error {
			updated = append(append([]management.OpenAICompatibility{}, *list...), entry)
			*list = updated
			return nil
		},
		afterUpdate)
	return updated, err
}

// The helpers below run one config API-key family's read-modify-write inside the
// console's provider write window. They are family-agnostic on purpose: the
// family is a runtime value, so a new credential list needs no new code path.

// appendConfigKeyProvider adds one credential to the family list.
func (h *Handler) appendConfigKeyProvider(
	ctx context.Context,
	client *management.Client,
	spec providerConfigFamilySpec,
	entry management.ConfigAPIKey,
	afterUpdate func(context.Context, []management.ConfigAPIKey),
) ([]management.ConfigAPIKey, error) {
	var updated []management.ConfigAPIKey
	err := gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			updated = append(append([]management.ConfigAPIKey{}, *list...), entry)
			*list = updated
			return nil
		},
		afterUpdate)
	return updated, err
}

// mutateConfigKeyProvider edits one credential at index. The list is read inside
// the write window, so the edit cannot be applied to a stale snapshot.
func (h *Handler) mutateConfigKeyProvider(
	ctx context.Context,
	client *management.Client,
	spec providerConfigFamilySpec,
	index int,
	apply func(*management.ConfigAPIKey),
	afterUpdate func(context.Context, []management.ConfigAPIKey),
) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			apply(&(*list)[index])
			return nil
		},
		afterUpdate)
}

// deleteConfigKeyProvider removes one credential at index.
func (h *Handler) deleteConfigKeyProvider(
	ctx context.Context,
	client *management.Client,
	spec providerConfigFamilySpec,
	index int,
	afterUpdate func(context.Context, []management.ConfigAPIKey),
) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.ConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			*list = append(append([]management.ConfigAPIKey{}, (*list)[:index]...), (*list)[index+1:]...)
			return nil
		},
		afterUpdate)
}
