package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

// The routing board is a configuration surface: CPA's priority tiers, weights and
// routing settings as one arrangement the operator rearranges and applies as a
// plan. It reads what CPA is configured to do; the dashboard's live routing panel
// shows what it did.

// ROUTING_MODELS_BUDGET bounds the per-credential model reads behind the model
// lens. A credential not read within it is reported unknown, never ineligible.
const ROUTING_MODELS_BUDGET = 10 * time.Second

type routingWeightDTO struct {
	Index     int    `json:"index"`
	AuthIndex string `json:"auth_index,omitempty"`
	Weight    *int64 `json:"weight"`
}

type routingMemberDTO struct {
	Key           string             `json:"key"`
	Kind          string             `json:"kind"`
	ID            string             `json:"id"`
	Family        string             `json:"family"`
	Name          string             `json:"name"`
	Prefix        string             `json:"prefix,omitempty"`
	Priority      int                `json:"priority"`
	Weights       []routingWeightDTO `json:"weights"`
	KeyCount      int                `json:"key_count"`
	IsDisabled    bool               `json:"is_disabled"`
	IsUnavailable bool               `json:"is_unavailable"`
	IsRuntimeOnly bool               `json:"is_runtime_only"`
}

type routingSettingsDTO struct {
	Strategy                      string `json:"strategy"`
	SessionAffinity               bool   `json:"session_affinity"`
	SessionAffinityTTL            string `json:"session_affinity_ttl"`
	RequestRetry                  int64  `json:"request_retry"`
	MaxRetryCredentials           int64  `json:"max_retry_credentials"`
	MaxRetryInterval              int64  `json:"max_retry_interval"`
	DisableCooling                bool   `json:"disable_cooling"`
	TransientErrorCooldownSeconds int64  `json:"transient_error_cooldown_seconds"`
	ForceModelPrefix              bool   `json:"force_model_prefix"`
}

type routingBoardDTO struct {
	Revision string             `json:"revision"`
	Settings routingSettingsDTO `json:"settings"`
	Members  []routingMemberDTO `json:"members"`
	Partial  []string           `json:"partial"`
}

type routingResultDTO struct {
	Key    string `json:"key"`
	Status string `json:"status"`
	Code   string `json:"code,omitempty"`
}

type routingOutcomeDTO struct {
	IsComplete bool               `json:"is_complete"`
	Results    []routingResultDTO `json:"results"`
	Board      *routingBoardDTO   `json:"board,omitempty"`
}

type routingModelsDTO struct {
	// Models lists, per member key, the model names a client can request from it.
	Models map[string][]string `json:"models"`
	// Unknown names the members whose models could not be read.
	Unknown []string `json:"unknown"`
}

func projectRoutingBoard(board operations.RoutingBoard) routingBoardDTO {
	settings := board.Settings
	dto := routingBoardDTO{
		Revision: board.Revision,
		Settings: routingSettingsDTO{
			Strategy:                      settings.Strategy,
			SessionAffinity:               settings.SessionAffinity,
			SessionAffinityTTL:            settings.SessionAffinityTTL,
			RequestRetry:                  settings.RequestRetry,
			MaxRetryCredentials:           settings.MaxRetryCredentials,
			MaxRetryInterval:              settings.MaxRetryInterval,
			DisableCooling:                settings.DisableCooling,
			TransientErrorCooldownSeconds: settings.TransientErrorCooldownSeconds,
			ForceModelPrefix:              settings.ForceModelPrefix,
		},
		Members: make([]routingMemberDTO, 0, len(board.Members)),
		Partial: append([]string{}, board.Partial...),
	}
	for _, member := range board.Members {
		weights := make([]routingWeightDTO, 0, len(member.Weights))
		for _, weight := range member.Weights {
			weights = append(weights, routingWeightDTO{Index: weight.Index, AuthIndex: weight.AuthIndex, Weight: weight.Weight})
		}
		dto.Members = append(dto.Members, routingMemberDTO{
			Key: member.Key, Kind: member.Kind, ID: member.ID, Family: member.Family, Name: member.Name,
			Prefix: member.Prefix, Priority: member.Priority, Weights: weights, KeyCount: member.KeyCount,
			IsDisabled: member.IsDisabled, IsUnavailable: member.IsUnavailable, IsRuntimeOnly: member.IsRuntimeOnly,
		})
	}
	return dto
}

func projectRoutingOutcome(outcome operations.RoutingOutcome) routingOutcomeDTO {
	dto := routingOutcomeDTO{IsComplete: outcome.IsComplete, Results: make([]routingResultDTO, 0, len(outcome.Results))}
	for _, result := range outcome.Results {
		dto.Results = append(dto.Results, routingResultDTO(result))
	}
	if outcome.Board != nil {
		board := projectRoutingBoard(*outcome.Board)
		dto.Board = &board
	}
	return dto
}

func priorityValue(priority *int) int {
	if priority == nil {
		return 0
	}
	return *priority
}

func weightValue(weight *int) *int64 {
	if weight == nil {
		return nil
	}
	value := int64(*weight)
	return &value
}

// readRoutingBoard assembles every schedulable credential with its priority and
// weights. A source CPA cannot answer for is named in Partial rather than failing
// the board, so one unreadable family does not hide the others.
func (h *Handler) readRoutingBoard(ctx context.Context, client *management.Client) (operations.RoutingBoard, error) {
	settings, err := client.RoutingSettings(ctx)
	if err != nil {
		return operations.RoutingBoard{}, err
	}
	customNames := h.loadProviderNames(ctx)
	members := make([]operations.RoutingMember, 0)
	partial := make([]string, 0)

	for _, spec := range providerConfigFamilies {
		entries, err := client.ConfigAPIKeys(ctx, spec.Family)
		if err != nil {
			if !management.IsMissingCapability(err) {
				partial = append(partial, string(spec.Family))
			}
			continue
		}
		// The rows are the provider list's rows, so a card carries the same id and
		// name the provider page shows.
		for index, item := range configKeyProviderItems(spec, entries, customNames) {
			entry := entries[index]
			members = append(members, operations.RoutingMember{
				Key: operations.RoutingKey(operations.ROUTING_MEMBER_PROVIDER, item.ID), Kind: operations.ROUTING_MEMBER_PROVIDER,
				ID: item.ID, Family: item.Family, Name: item.Name, Prefix: entry.Prefix, Priority: priorityValue(entry.Priority),
				Weights:    []operations.RoutingWeight{{Index: 0, AuthIndex: entry.AuthIndex, Weight: weightValue(entry.Weight)}},
				KeyCount:   1,
				IsDisabled: item.Disabled,
			})
		}
	}

	if compat, err := client.OpenAICompatibility(ctx); err != nil {
		partial = append(partial, openAICompatibilityFamily)
	} else {
		for index, entry := range compat.Entries {
			id := fmt.Sprintf("%s%d", openAICompatIDPrefix, index)
			name := firstNonEmpty(customNames[id], entry.Name, "OpenAI Compatible")
			weights := make([]operations.RoutingWeight, 0, len(entry.APIKeyEntries))
			for keyIndex, key := range entry.APIKeyEntries {
				weights = append(weights, operations.RoutingWeight{Index: keyIndex, AuthIndex: key.AuthIndex, Weight: weightValue(key.Weight)})
			}
			members = append(members, operations.RoutingMember{
				Key: operations.RoutingKey(operations.ROUTING_MEMBER_PROVIDER, id), Kind: operations.ROUTING_MEMBER_PROVIDER,
				ID: id, Family: openAICompatibilityFamily, Name: name, Prefix: entry.Prefix, Priority: priorityValue(entry.Priority),
				Weights: weights, KeyCount: len(entry.APIKeyEntries) + len(entry.LegacyAPIKeys), IsDisabled: entry.Disabled,
			})
		}
	}

	if files, err := client.AuthFiles(ctx); err != nil {
		partial = append(partial, "auth-files")
	} else {
		displayNames := map[string]string{}
		if h.repo != nil {
			if stored, err := h.repo.ListCredentialDisplayNames(ctx, defaultInstanceID()); err == nil {
				for name, entry := range stored {
					displayNames[name] = entry.DisplayName
				}
			}
		}
		for _, file := range files.Files {
			if strings.TrimSpace(file.Name) == "" {
				continue
			}
			members = append(members, operations.RoutingMember{
				Key: operations.RoutingKey(operations.ROUTING_MEMBER_CREDENTIAL, file.Name), Kind: operations.ROUTING_MEMBER_CREDENTIAL,
				ID:     file.Name,
				Family: strings.ToLower(firstNonEmpty(file.Provider, file.Type)),
				Name:   boundedText(firstNonEmpty(displayNames[file.Name], file.Label, file.Name), managementAuthFileFieldLimit),
				// CPA reports no priority as absent, which it runs as 0.
				Priority:      file.Priority,
				Weights:       []operations.RoutingWeight{{Index: 0, AuthIndex: file.AuthIndex, Weight: file.Weight}},
				KeyCount:      1,
				IsDisabled:    file.Disabled,
				IsUnavailable: file.Unavailable,
				IsRuntimeOnly: file.RuntimeOnly,
			})
		}
	}
	return operations.NewRoutingBoard(settings, members, partial), nil
}

func (h *Handler) getRouting(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	board, err := h.readRoutingBoard(request.Context(), client)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, projectRoutingBoard(board))
}

func (h *Handler) patchRouting(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var submitted operations.RoutingPlan
	if err := decodeManagementJSON(writer, request, 1024*1024, &submitted); err != nil {
		return
	}
	plan, err := operations.NormalizeRoutingPlan(submitted)
	if err != nil {
		writeRoutingError(writer, err)
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	outcome, err := h.applyRoutingPlan(request.Context(), client, plan, func(action, targetType, targetID, result string, details map[string]any) error {
		return h.recordAudit(request, action, targetType, targetID, result, details)
	})
	if err != nil {
		writeRoutingError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, projectRoutingOutcome(outcome))
}

func writeRoutingError(writer http.ResponseWriter, err error) {
	var detailed interface{ FailureDetail() string }
	switch {
	case errors.As(err, &detailed):
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": detailed.FailureDetail(), "code": "invalid_parameters"})
	case errors.Is(err, operations.ErrRoutingConflict):
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "the routing board changed; reload and arrange again", "code": "routing_conflict"})
	case errors.Is(err, operations.ErrRoutingNoChanges):
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "the plan matches the current routing", "code": "routing_no_changes"})
	case errors.Is(err, management.ErrInvalidConfigChange):
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "config_invalid_change"})
	default:
		writeProviderWriteError(writer, err)
	}
}

// routingCredentialEdit is one credential's changed fields, in plan order.
type routingCredentialEdit struct {
	member operations.RoutingMember
	fields map[string]any
}

// applyRoutingPlan applies a plan prepared against the board's revision.
//
// The provider priorities and weights and the routing settings are one
// configuration change set: one encrypted pre-write copy and one CPA write
// guarded by the stored file's version. Credentials live in their own files, so
// each is patched and read back in turn. The two halves cannot be one upstream
// transaction; the outcome reports each target separately and stops at the
// first credential that fails, rather than promising a rollback CPA cannot do.
func (h *Handler) applyRoutingPlan(ctx context.Context, client *management.Client, plan operations.NormalizedRoutingPlan, audit providerAudit) (operations.RoutingOutcome, error) {
	if err := h.providerWrites.acquire(ctx); err != nil {
		return operations.RoutingOutcome{}, err
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()

	board, err := h.readRoutingBoard(ctx, client)
	if err != nil {
		return operations.RoutingOutcome{}, err
	}
	if !strings.EqualFold(board.Revision, plan.Revision) {
		return operations.RoutingOutcome{}, operations.ErrRoutingConflict
	}

	settingKeys := make([]string, 0, len(plan.Settings))
	for key, value := range plan.Settings {
		if value != operations.RoutingSettingValue(board.Settings, key) {
			settingKeys = append(settingKeys, key)
		}
	}
	sort.Strings(settingKeys)

	providerEdits := map[string]map[int]operations.RoutingMemberEdit{}
	providerKeys := make([]string, 0)
	credentialEdits := make([]routingCredentialEdit, 0)
	for _, edit := range plan.Members {
		member, ok := board.Member(edit.Key)
		if !ok {
			return operations.RoutingOutcome{}, operations.ErrRoutingConflict
		}
		edit = effectiveRoutingEdit(member, edit)
		if edit.Priority == nil && len(edit.Weights) == 0 {
			continue
		}
		for _, weight := range edit.Weights {
			if weight.Index >= len(member.Weights) {
				return operations.RoutingOutcome{}, operations.ErrRoutingConflict
			}
		}
		if member.Kind == operations.ROUTING_MEMBER_CREDENTIAL {
			if member.IsRuntimeOnly {
				return operations.RoutingOutcome{}, routingInvalid("credential " + member.ID + " has no file to store routing in")
			}
			fields := map[string]any{}
			if edit.Priority != nil {
				fields["priority"] = *edit.Priority
			}
			if len(edit.Weights) > 0 {
				if weight := edit.Weights[0].Weight; weight != nil {
					fields["weight"] = *weight
				} else {
					fields["weight"] = nil
				}
			}
			credentialEdits = append(credentialEdits, routingCredentialEdit{member: member, fields: fields})
			continue
		}
		family, index, err := parseProviderID(member.ID)
		if err != nil {
			return operations.RoutingOutcome{}, operations.ErrRoutingConflict
		}
		if providerEdits[family] == nil {
			providerEdits[family] = map[int]operations.RoutingMemberEdit{}
		}
		providerEdits[family][index] = edit
		providerKeys = append(providerKeys, member.Key)
	}
	if len(settingKeys) == 0 && len(providerKeys) == 0 && len(credentialEdits) == 0 {
		return operations.RoutingOutcome{}, operations.ErrRoutingNoChanges
	}

	changes, err := h.routingConfigChanges(ctx, client, board, providerEdits)
	if err != nil {
		return operations.RoutingOutcome{}, err
	}
	for _, key := range settingKeys {
		path := management.ROUTING_SETTING_PATHS[key]
		if value := plan.Settings[key]; value == nil {
			changes = append(changes, management.ConfigChange{Path: path, Remove: true})
		} else {
			changes = append(changes, management.ConfigChange{Path: path, Value: value})
		}
	}
	paths := make([]string, 0, len(changes))
	for _, change := range changes {
		paths = append(paths, strings.Join(change.Path, "."))
	}
	credentialNames := make([]string, 0, len(credentialEdits))
	for _, edit := range credentialEdits {
		credentialNames = append(credentialNames, edit.member.ID)
	}
	if auditErr := audit("routing.apply", "routing", "board", "attempt", map[string]any{"revision": board.Revision, "paths": paths, "credentials": credentialNames}); auditErr != nil {
		return operations.RoutingOutcome{}, newProviderWriteError(http.StatusInternalServerError, "audit failure; routing plan aborted")
	}

	results := make([]operations.RoutingResult, 0, len(providerKeys)+len(credentialEdits)+1)
	configKeys := append([]string{}, providerKeys...)
	if len(settingKeys) > 0 {
		configKeys = append([]string{operations.ROUTING_SETTINGS_KEY}, configKeys...)
	}
	markAll := func(keys []string, status, code string) {
		for _, key := range keys {
			results = append(results, operations.RoutingResult{Key: key, Status: status, Code: code})
		}
	}
	pendingCredentials := func(from int) []string {
		keys := make([]string, 0, len(credentialEdits)-from)
		for _, edit := range credentialEdits[from:] {
			keys = append(keys, edit.member.Key)
		}
		return keys
	}

	isComplete := true
	if len(changes) > 0 {
		err := client.ApplyConfigChanges(management.WithBackupReason(ctx, management.BackupReasonRoutingPlan), changes)
		switch {
		case err == nil:
			h.afterConfigWrite()
			markAll(configKeys, operations.ROUTING_APPLIED, "")
		case errors.Is(err, management.ErrConfigPartiallyApplied):
			// Part of the change set landed; which part is not knowable from here.
			h.afterConfigWrite()
			isComplete = false
			markAll(configKeys, operations.ROUTING_UNCERTAIN, "config_partially_applied")
			markAll(pendingCredentials(0), operations.ROUTING_NOT_ATTEMPTED, "")
			credentialEdits = nil
		default:
			// Nothing was written, so this is a refusal rather than an outcome.
			_ = audit("routing.apply", "routing", "board", "failure", configWriteFailureDetail(err, map[string]any{"paths": paths}))
			return operations.RoutingOutcome{}, err
		}
	}
	for position, edit := range credentialEdits {
		_, err := h.applyManagementAuthFileFields(ctx, client, edit.member.ID, edit.member.Weights[0].AuthIndex, edit.fields)
		if err == nil {
			results = append(results, operations.RoutingResult{Key: edit.member.Key, Status: operations.ROUTING_APPLIED})
			continue
		}
		isComplete = false
		switch {
		case errors.Is(err, errAuthFileIdentityStale):
			results = append(results, operations.RoutingResult{Key: edit.member.Key, Status: operations.ROUTING_FAILED, Code: "routing_conflict"})
		case errors.Is(err, errAuthFileFieldsNotVerified):
			// CPA accepted the write but did not read back as requested.
			results = append(results, operations.RoutingResult{Key: edit.member.Key, Status: operations.ROUTING_UNCERTAIN, Code: "not_verified"})
		default:
			results = append(results, operations.RoutingResult{Key: edit.member.Key, Status: operations.ROUTING_FAILED, Code: "upstream_error"})
		}
		markAll(pendingCredentials(position+1), operations.ROUTING_NOT_ATTEMPTED, "")
		break
	}

	outcomeDetail := map[string]any{"paths": paths, "credentials": credentialNames}
	outcome := operations.RoutingOutcome{IsComplete: isComplete, Results: results}
	if fresh, err := h.readRoutingBoard(ctx, client); err == nil {
		outcome.Board = &fresh
		outcomeDetail["revision"] = fresh.Revision
	}
	auditResult := "success"
	if !isComplete {
		auditResult = "failure"
		outcomeDetail["results"] = results
	}
	// The writes have landed; an audit failure here is logged by recordAudit and
	// cannot undo them, so the operator still receives the outcome.
	_ = audit("routing.apply", "routing", "board", auditResult, outcomeDetail)
	return outcome, nil
}

// effectiveRoutingEdit drops the parts of an edit that already hold the
// requested value, so an unchanged member writes nothing.
func effectiveRoutingEdit(member operations.RoutingMember, edit operations.RoutingMemberEdit) operations.RoutingMemberEdit {
	if edit.Priority != nil && *edit.Priority == member.Priority {
		edit.Priority = nil
	}
	weights := make([]operations.RoutingWeightEdit, 0, len(edit.Weights))
	for _, weight := range edit.Weights {
		if weight.Index < len(member.Weights) && equalWeight(member.Weights[weight.Index].Weight, weight.Weight) {
			continue
		}
		weights = append(weights, weight)
	}
	edit.Weights = weights
	return edit
}

func equalWeight(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func routingInvalid(detail string) error {
	return newProviderWriteErrorWithCode(http.StatusBadRequest, detail, "invalid_parameters")
}

// routingConfigChanges rewrites each edited provider family with only the
// priorities and weights changed. Every other setting, sibling key and group
// is carried through the family's editable list unchanged.
func (h *Handler) routingConfigChanges(ctx context.Context, client *management.Client, board operations.RoutingBoard, edits map[string]map[int]operations.RoutingMemberEdit) ([]management.ConfigChange, error) {
	families := make([]string, 0, len(edits))
	for family := range edits {
		families = append(families, family)
	}
	sort.Strings(families)
	changes := make([]management.ConfigChange, 0, len(families))
	for _, family := range families {
		familyEdits := edits[family]
		if family == openAICompatibilityFamily {
			entries, err := client.EditableOpenAICompatibility(ctx)
			if err != nil {
				return nil, err
			}
			for index, edit := range familyEdits {
				if index >= len(entries) {
					return nil, operations.ErrRoutingConflict
				}
				member, _ := board.Member(edit.Key)
				entry := &entries[index]
				if len(entry.APIKeyEntries) != len(member.Weights) {
					return nil, operations.ErrRoutingConflict
				}
				for keyIndex, weight := range member.Weights {
					if entry.APIKeyEntries[keyIndex].AuthIndex != weight.AuthIndex {
						return nil, operations.ErrRoutingConflict
					}
				}
				if edit.Priority != nil {
					priority := *edit.Priority
					entry.Priority = &priority
				}
				for _, weight := range edit.Weights {
					entry.APIKeyEntries[weight.Index].Weight = intWeight(weight.Weight)
				}
			}
			change, err := management.OpenAICompatibilityChange(entries)
			if err != nil {
				return nil, err
			}
			changes = append(changes, change)
			continue
		}
		spec, ok := lookupProviderConfigFamily(family)
		if !ok {
			return nil, operations.ErrRoutingConflict
		}
		entries, err := client.EditableConfigAPIKeys(ctx, spec.Family)
		if err != nil {
			return nil, err
		}
		for index, edit := range familyEdits {
			member, _ := board.Member(edit.Key)
			if index >= len(entries) || entries[index].AuthIndex != member.Weights[0].AuthIndex {
				return nil, operations.ErrRoutingConflict
			}
			if edit.Priority != nil {
				priority := *edit.Priority
				entries[index].Priority = &priority
			}
			for _, weight := range edit.Weights {
				entries[index].Weight = intWeight(weight.Weight)
			}
		}
		change, err := management.ConfigAPIKeysChange(spec.Family, entries)
		if err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, nil
}

func intWeight(weight *int64) *int {
	if weight == nil {
		return nil
	}
	value := int(*weight)
	return &value
}

// getRoutingModels answers which model names each member can serve, for the
// board's model lens. Configured providers are read from their model lists (or
// CPA's built-in list for a family entry that names none); a credential is read
// from CPA's registry, which already applies its aliases, prefix and exclusions.
func (h *Handler) getRoutingModels(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), ROUTING_MODELS_BUDGET)
	defer cancel()
	settings, err := client.RoutingSettings(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	result := routingModelsDTO{Models: map[string][]string{}, Unknown: []string{}}
	callable := func(names []string, prefix string, excluded []string) []string {
		ids := make([]string, 0, len(names)*2)
		prefix = strings.Trim(strings.TrimSpace(prefix), "/")
		for _, name := range names {
			name = strings.TrimSpace(name)
			if name == "" || operations.IsModelExcluded(name, excluded) {
				continue
			}
			// A prefixed credential also answers the bare name unless prefixes
			// are forced, in which case only a prefix equal to the model is bare.
			if prefix == "" || !settings.ForceModelPrefix || prefix == name {
				ids = append(ids, name)
			}
			if prefix != "" {
				ids = append(ids, prefix+"/"+name)
			}
		}
		sort.Strings(ids)
		return compactStrings(ids)
	}
	builtIn := map[string][]string{}
	for _, spec := range providerConfigFamilies {
		entries, err := client.ConfigAPIKeys(ctx, spec.Family)
		if err != nil {
			if management.IsMissingCapability(err) {
				continue
			}
			writeCPAFacadeError(writer, err)
			return
		}
		for index, entry := range entries {
			key := operations.RoutingKey(operations.ROUTING_MEMBER_PROVIDER, fmt.Sprintf("%s%d", spec.IDPrefix, index))
			if management.IsExcludedAll(entry.ExcludedModels) {
				result.Models[key] = []string{}
				continue
			}
			names := make([]string, 0, len(entry.Models))
			for _, model := range entry.Models {
				names = append(names, firstNonEmpty(strings.TrimSpace(model.Alias), model.Name))
			}
			if len(names) == 0 {
				family := string(spec.Family)
				if _, isRead := builtIn[family]; !isRead {
					definitions, err := client.StaticModelDefinitions(ctx, family)
					builtIn[family] = nil
					if err == nil {
						for _, definition := range definitions {
							builtIn[family] = append(builtIn[family], definition.ID)
						}
					}
				}
				if builtIn[family] == nil {
					result.Unknown = append(result.Unknown, key)
					continue
				}
				names = builtIn[family]
			}
			result.Models[key] = callable(names, entry.Prefix, entry.ExcludedModels)
		}
	}
	compat, err := client.OpenAICompatibility(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	for index, entry := range compat.Entries {
		key := operations.RoutingKey(operations.ROUTING_MEMBER_PROVIDER, fmt.Sprintf("%s%d", openAICompatIDPrefix, index))
		if entry.Disabled {
			result.Models[key] = []string{}
			continue
		}
		names := make([]string, 0, len(entry.Models))
		for _, model := range entry.Models {
			names = append(names, firstNonEmpty(strings.TrimSpace(model.Alias), model.Name))
		}
		if len(names) == 0 {
			result.Unknown = append(result.Unknown, key)
			continue
		}
		result.Models[key] = callable(names, entry.Prefix, nil)
	}
	files, err := client.AuthFiles(ctx)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, 4)
	for _, file := range files.Files {
		if strings.TrimSpace(file.Name) == "" {
			continue
		}
		key := operations.RoutingKey(operations.ROUTING_MEMBER_CREDENTIAL, file.Name)
		if file.Disabled {
			mu.Lock()
			result.Models[key] = []string{}
			mu.Unlock()
			continue
		}
		if len(file.Models) > 0 {
			mu.Lock()
			result.Models[key] = authModelIDs(file.Models)
			mu.Unlock()
			continue
		}
		wg.Add(1)
		go func(key, name string) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				mu.Lock()
				result.Unknown = append(result.Unknown, key)
				mu.Unlock()
				return
			}
			defer func() { <-slots }()
			models, err := client.AuthFileModels(ctx, name)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				result.Unknown = append(result.Unknown, key)
				return
			}
			result.Models[key] = authModelIDs(models)
		}(key, file.Name)
	}
	wg.Wait()
	sort.Strings(result.Unknown)
	writeJSON(writer, http.StatusOK, result)
}

func authModelIDs(models []management.AuthModel) []string {
	ids := make([]string, 0, len(models))
	for _, model := range models {
		if id := strings.TrimSpace(model.ID); id != "" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return compactStrings(ids)
}

func compactStrings(sorted []string) []string {
	kept := sorted[:0]
	for index, value := range sorted {
		if index == 0 || value != sorted[index-1] {
			kept = append(kept, value)
		}
	}
	return kept
}
