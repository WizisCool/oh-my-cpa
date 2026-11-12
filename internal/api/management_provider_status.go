package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

type patchProviderStatusRequest struct {
	beforeWrite func(context.Context) error
	Family      string `json:"family"`
	Index       int    `json:"index"`
	Disabled    bool   `json:"disabled"`
	// ExpectedAuthIndex and ExpectedName are optional preconditions. Providers
	// are addressed positionally, and the client now retries a transient failure,
	// so between two attempts another session could delete a provider and shift
	// every later index. Without a precondition that retry would toggle a
	// different provider than the operator clicked, silently. When either is
	// supplied it must still match the entry at that index, or the write is
	// refused with a conflict instead of touching the wrong row.
	//
	// They are optional rather than required so an older client keeps working;
	// the browser always sends whichever of the two its row carries.
	ExpectedAuthIndex string `json:"expected_auth_index,omitempty"`
	ExpectedName      string `json:"expected_name,omitempty"`
}

// verifyAuthIndex refuses the write when the caller named the provider it meant
// and the entry at that position is not it.
//
// The client retries a transient failure, and positions shift when a provider is
// deleted; comparing the identity the operator actually saw turns a retry that
// would have toggled a different provider into an explicit conflict.
func (req patchProviderStatusRequest) verifyAuthIndex(actual string) error {
	expected := strings.TrimSpace(req.ExpectedAuthIndex)
	if expected == "" {
		return nil
	}
	if strings.TrimSpace(actual) != expected {
		return newProviderWriteErrorWithCode(
			http.StatusConflict,
			"the provider at this position changed since it was read; refresh and try again",
			providerStaleIdentityCode,
		)
	}
	return nil
}

// verifyName is the same precondition for the family that has no auth index:
// openai-compatibility entries are identified by their configured name.
func (req patchProviderStatusRequest) verifyName(actual string) error {
	expected := strings.TrimSpace(req.ExpectedName)
	if expected == "" {
		return nil
	}
	if strings.TrimSpace(actual) != expected {
		return newProviderWriteErrorWithCode(
			http.StatusConflict,
			"the provider at this position changed since it was read; refresh and try again",
			providerStaleIdentityCode,
		)
	}
	return nil
}

func (h *Handler) patchManagementProviderStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req patchProviderStatusRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	// A negative index is rejected here rather than by the bounds check below,
	// which compares against a length and would accept it.
	if req.Index < 0 {
		writeError(writer, http.StatusBadRequest, "provider index must not be negative")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	ctx := request.Context()
	targetID := fmt.Sprintf("%s-%d", req.Family, req.Index)

	if auditErr := h.recordAudit(request, "provider.toggle_status", "provider", targetID, "attempt", map[string]any{"disabled": req.Disabled}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; status update aborted")
		return
	}

	if h.stateCoord != nil && req.beforeWrite == nil {
		version, handled, mutErr := h.mutateProviderStatusOptimistic(request, req, targetID)
		if handled {
			if mutErr != nil {
				_ = h.recordAudit(request, "provider.toggle_status", "provider", targetID, "failure", map[string]any{"error": mutErr.Error()})
				writeProviderWriteError(writer, mutErr)
				return
			}
			setStateVersionHeader(writer, version)
			writeJSON(writer, http.StatusOK, map[string]any{
				"status":   "ok",
				"family":   req.Family,
				"index":    req.Index,
				"disabled": req.Disabled,
				"version":  version,
			})
			return
		}
	}

	if err := h.writeProviderStatus(ctx, client, req); err != nil {
		_ = h.recordAudit(request, "provider.toggle_status", "provider", targetID, "failure", map[string]any{"error": err.Error()})
		writeProviderWriteError(writer, err)
		return
	}

	_ = h.recordAudit(request, "provider.toggle_status", "provider", targetID, "success", map[string]any{"disabled": req.Disabled})
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":   "ok",
		"family":   req.Family,
		"index":    req.Index,
		"disabled": req.Disabled,
	})
}

// writeProviderStatus is the whole-list read-modify-write behind one toggle. It
// reports the outcome instead of replying, because the caller records the audit
// result and composes the response only after the write window is released.
func (h *Handler) writeProviderStatus(ctx context.Context, client *management.Client, req patchProviderStatusRequest) error {
	if spec, ok := lookupProviderConfigFamily(req.Family); ok {
		return h.writeConfigKeyProviderStatus(ctx, client, spec, req)
	}
	switch req.Family {
	case openAICompatibilityFamily:
		return gatedProviderListWrite(h, ctx,
			func(ctx context.Context) ([]management.OpenAICompatibility, error) {
				return client.EditableOpenAICompatibility(ctx)
			},
			func(ctx context.Context, list []management.OpenAICompatibility) error {
				return client.UpdateOpenAICompatibility(ctx, list)
			},
			func(list *[]management.OpenAICompatibility) error {
				if req.beforeWrite != nil {
					if err := req.beforeWrite(ctx); err != nil {
						return err
					}
				}
				if req.Index >= len(*list) {
					return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
				}
				if err := req.verifyName((*list)[req.Index].Name); err != nil {
					return err
				}
				(*list)[req.Index].Disabled = req.Disabled
				return nil
			},
			nil)
	default:
		return newProviderWriteError(http.StatusBadRequest, "provider family does not support status toggle")
	}
}

// writeConfigKeyProviderStatus flips one config API-key credential's enable state.
//
// These entries have no disabled field in CPA's schema, so the gateway cannot see
// a local preference. CPA's own disable mechanism is the excluded-all marker in
// excluded-models; anything else only repaints the UI while the gateway keeps
// routing — that is exactly the fallback leak this used to cause.
func (h *Handler) writeConfigKeyProviderStatus(ctx context.Context, client *management.Client, spec providerConfigFamilySpec, req patchProviderStatusRequest) error {
	return gatedProviderListWrite(h, ctx,
		func(ctx context.Context) ([]management.ConfigAPIKey, error) {
			return client.EditableConfigAPIKeys(ctx, spec.Family)
		},
		func(ctx context.Context, list []management.ConfigAPIKey) error {
			return client.UpdateConfigAPIKeys(ctx, spec.Family, list)
		},
		func(list *[]management.ConfigAPIKey) error {
			if req.beforeWrite != nil {
				if err := req.beforeWrite(ctx); err != nil {
					return err
				}
			}
			if req.Index >= len(*list) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			if err := req.verifyAuthIndex((*list)[req.Index].AuthIndex); err != nil {
				return err
			}
			(*list)[req.Index].ExcludedModels = management.SetExcludedAll((*list)[req.Index].ExcludedModels, req.Disabled)
			return nil
		},
		nil)
}

// mutateProviderStatusOptimistic applies a provider enable/disable toggle directly
// onto the in-memory StateCoordinator projection in <1ms and schedules a 250ms
// debounced flush, attaching the deferred outcome audit atomically under the same lock.
func (h *Handler) mutateProviderStatusOptimistic(request *http.Request, req patchProviderStatusRequest, targetID string) (uint64, bool, error) {
	details := map[string]any{"disabled": req.Disabled}
	if spec, ok := lookupProviderConfigFamily(req.Family); ok {
		domain := statecoord.DomainKey(stateDomainProviderFamilyPrefix + string(spec.Family))
		version, err := h.mutateCoordinatorWithAudit(request, domain, "provider.toggle_status", "provider", targetID, details, func(state *projectedConfigState) error {
			if state.RuntimeOnlyFam[spec.Family] {
				return errRuntimeOnlyProviderSlice
			}
			entries := state.ConfigFamilies[spec.Family]
			if req.Index >= len(entries) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			if err := req.verifyAuthIndex(entries[req.Index].AuthIndex); err != nil {
				return err
			}
			entries[req.Index].ExcludedModels = management.SetExcludedAll(entries[req.Index].ExcludedModels, req.Disabled)
			state.ConfigFamilies[spec.Family] = entries
			if state.PendingFamilyToggles == nil {
				state.PendingFamilyToggles = make(map[management.ConfigKeyFamily]map[string]pendingProviderToggle)
			}
			if state.PendingFamilyToggles[spec.Family] == nil {
				state.PendingFamilyToggles[spec.Family] = make(map[string]pendingProviderToggle)
			}
			state.ProviderToggleSeq++
			selector := familyToggleSelector(req.Index, entries[req.Index].AuthIndex, entries[req.Index].APIKey)
			state.PendingFamilyToggles[spec.Family][selector] = pendingProviderToggle{
				Disabled: req.Disabled,
				Seq:      state.ProviderToggleSeq,
			}
			return nil
		})
		if errors.Is(err, errRuntimeOnlyProviderSlice) {
			return 0, false, nil
		}
		if err == nil {
			h.providerKeyMasks.invalidate()
		}
		return version, true, err
	}

	if req.Family == openAICompatibilityFamily {
		version, err := h.mutateCoordinatorWithAudit(request, stateDomainOpenAICompat, "provider.toggle_status", "provider", targetID, details, func(state *projectedConfigState) error {
			if state.OpenAIRuntime {
				return errRuntimeOnlyProviderSlice
			}
			if req.Index >= len(state.OpenAICompat) {
				return newProviderWriteError(http.StatusNotFound, "provider index out of bounds")
			}
			if err := req.verifyName(state.OpenAICompat[req.Index].Name); err != nil {
				return err
			}
			state.OpenAICompat[req.Index].Disabled = req.Disabled
			if state.PendingOpenAIToggles == nil {
				state.PendingOpenAIToggles = make(map[string]pendingProviderToggle)
			}
			state.ProviderToggleSeq++
			selector := openAIToggleSelector(req.Index, state.OpenAICompat[req.Index].Name)
			state.PendingOpenAIToggles[selector] = pendingProviderToggle{
				Disabled: req.Disabled,
				Seq:      state.ProviderToggleSeq,
			}
			return nil
		})
		if errors.Is(err, errRuntimeOnlyProviderSlice) {
			return 0, false, nil
		}
		if err == nil {
			h.providerKeyMasks.invalidate()
		}
		return version, true, err
	}

	return 0, true, newProviderWriteError(http.StatusBadRequest, "provider family does not support status toggle")
}
