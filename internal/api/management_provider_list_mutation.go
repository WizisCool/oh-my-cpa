package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// The openai-compatibility append helper builds the new entry against the list as it
// exists inside the write window, so an append cannot be based on a stale length.
func (h *Handler) appendOpenAICompatibilityGated(
	ctx context.Context,
	client *management.Client,
	entry management.OpenAICompatibility,
	afterUpdate func(context.Context, []management.OpenAICompatibility) error,
) ([]management.OpenAICompatibility, error) {
	var updated []management.OpenAICompatibility
	err := gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.OpenAICompatibility, error) {
			return client.EditableOpenAICompatibility(ctx)
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

// appendConfigKeyProviders saves every submitted credential in one write window.
func (h *Handler) appendConfigKeyProviders(
	ctx context.Context,
	client *management.Client,
	spec providerConfigFamilySpec,
	entries []management.ConfigAPIKey,
	afterUpdate func(context.Context, []management.ConfigAPIKey) error,
) ([]management.ConfigAPIKey, error) {
	var updated []management.ConfigAPIKey
	err := gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.EditableConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return updateConfigKeysAndVerifyVertexPolicy(ctx, client, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if err := verifyConfigProviderKeys(*list, entries, -1); err != nil {
				return err
			}
			updated = append(append([]management.ConfigAPIKey{}, *list...), entries...)
			*list = updated
			return nil
		},
		afterUpdate)
	return updated, err
}

// mutateConfigKeyProviders keeps the edited row's position and appends its new
// credentials. Appending leaves every neighbouring positional identity intact.
func (h *Handler) mutateConfigKeyProviders(
	ctx context.Context,
	client *management.Client,
	spec providerConfigFamilySpec,
	index int,
	apply func(management.ConfigAPIKey) ([]management.ConfigAPIKey, error),
	afterUpdate func(context.Context, []management.ConfigAPIKey, int) error,
) error {
	added := 0
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.EditableConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return updateConfigKeysAndVerifyVertexPolicy(ctx, client, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			entries, err := apply((*list)[index])
			if err != nil {
				return err
			}
			if err := verifyConfigProviderKeys(*list, entries, index); err != nil {
				return err
			}
			(*list)[index] = entries[0]
			*list = append(*list, entries[1:]...)
			added = len(entries) - 1
			return nil
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error { return afterUpdate(ctx, list, added) })
}

// deleteConfigKeyProvider removes one credential at index.
func (h *Handler) deleteConfigKeyProvider(
	ctx context.Context,
	client *management.Client,
	spec providerConfigFamilySpec,
	index int,
	afterUpdate func(context.Context, []management.ConfigAPIKey) error,
) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.EditableConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return updateConfigKeysAndVerifyVertexPolicy(ctx, client, spec.Family, list)
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

// Vertex routing policies retain explicit false and alias-specific inheritance.
// Verify the stored configuration, not runtime inference or model-name detection.
func updateConfigKeysAndVerifyVertexPolicy(ctx context.Context, client *management.Client, family management.ConfigKeyFamily, requested []management.ConfigAPIKey) error {
	if err := client.UpdateConfigAPIKeys(ctx, family, requested); err != nil {
		return err
	}
	if family != management.ConfigFamilyVertex {
		return nil
	}
	current, err := client.EditableConfigAPIKeys(ctx, family)
	failed := func() error {
		return newProviderWriteError(http.StatusBadGateway, "Vertex OpenAPI settings could not be verified; reload before retrying")
	}
	if err != nil || len(current) != len(requested) {
		return failed()
	}
	for index, expected := range requested {
		actual := current[index]
		if actual.APIKey != expected.APIKey || !equalOptionalBool(actual.OpenAPI, expected.OpenAPI) || strings.TrimSpace(actual.OpenAPILocation) != strings.TrimSpace(expected.OpenAPILocation) || len(actual.Models) != len(expected.Models) {
			return failed()
		}
		for position, model := range expected.Models {
			observed := actual.Models[position]
			if observed.Name != model.Name || observed.Alias != model.Alias || !equalOptionalBool(observed.OpenAPI, model.OpenAPI) {
				return failed()
			}
		}
	}
	return nil
}
