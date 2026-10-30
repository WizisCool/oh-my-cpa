package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// CPA schedules a request in strict priority tiers: the highest priority with an
// available credential serves it, and the strategy spreads requests only among
// that tier's credentials. The routing board is that order made explicit - every
// schedulable credential with the priority and weight that decide its turn - so
// it can be rearranged as one plan instead of number by number in each editor.

// Member kinds: a provider is one config API-key row (one key, or an
// OpenAI-compatible provider with several keys sharing one priority); a
// credential is one OAuth auth file.
const (
	ROUTING_MEMBER_PROVIDER   = "provider"
	ROUTING_MEMBER_CREDENTIAL = "credential"
)

// ROUTING_WEIGHT_MAX is CPA's bound for a credential weight.
const ROUTING_WEIGHT_MAX = 1_000_000

// MAX_ROUTING_MEMBERS bounds one plan. A board larger than this is not one an
// operator arranges by hand.
const MAX_ROUTING_MEMBERS = 2000

var (
	// ErrRoutingConflict reports a plan prepared against a board that has since
	// changed: another writer moved a credential, or a credential was replaced.
	// Its text is the capability code an Agent reads.
	ErrRoutingConflict = errors.New("resource_conflict")
	// ErrRoutingNoChanges reports a plan that matches the current board: a call
	// the caller can correct, not a failure.
	ErrRoutingNoChanges = errors.New("invalid_parameters")
)

type RoutingWeight struct {
	// Index is the key's position inside its member; the board revision pins
	// that layout, so it is a sound address for an edit.
	Index     int    `json:"index"`
	AuthIndex string `json:"auth_index,omitempty"`
	// Weight is nil when the key states none, which CPA runs as 1.
	Weight *int64 `json:"weight"`
}

type RoutingMember struct {
	Key      string `json:"key"`
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Family   string `json:"family"`
	Name     string `json:"name"`
	Prefix   string `json:"prefix,omitempty"`
	Priority int    `json:"priority"`
	// Weights holds one entry per key whose weight can be edited.
	Weights []RoutingWeight `json:"weights"`
	// KeyCount is every key the member schedules, including keys in a legacy
	// spelling that carry no weight of their own.
	KeyCount      int  `json:"key_count"`
	IsDisabled    bool `json:"is_disabled"`
	IsUnavailable bool `json:"is_unavailable"`
	// IsRuntimeOnly marks a credential with no file behind it: CPA has nothing to
	// store a new priority in, so it is shown but cannot be moved.
	IsRuntimeOnly bool `json:"is_runtime_only"`
}

type RoutingBoard struct {
	Revision string                     `json:"revision"`
	Settings management.RoutingSettings `json:"settings"`
	Members  []RoutingMember            `json:"members"`
	// Partial names the sources that could not be read; their members are absent.
	Partial []string `json:"partial,omitempty"`
}

// NewRoutingBoard assembles and seals a board. A strategy CPA does not recognise
// is shown as round-robin, which is what CPA silently runs in its place.
func NewRoutingBoard(settings management.RoutingSettings, members []RoutingMember, partial []string) RoutingBoard {
	strategy, known := normalizeRoutingStrategy(settings.Strategy)
	if !known {
		strategy = "round-robin"
	}
	settings.Strategy = strategy
	if members == nil {
		members = []RoutingMember{}
	}
	board := RoutingBoard{Settings: settings, Members: members, Partial: partial}
	board.Seal()
	return board
}

// RoutingKey is a member's address on the board.
func RoutingKey(kind, id string) string { return kind + ":" + id }

// Seal stamps the board with the revision a plan must quote back. It covers only
// what decides the order - identity, priority, weight and state - so an
// unrelated configuration save does not invalidate an operator's arrangement.
func (board *RoutingBoard) Seal() {
	type sealedMember struct {
		Key      string          `json:"k"`
		Priority int             `json:"p"`
		Weights  []RoutingWeight `json:"w"`
		KeyCount int             `json:"c"`
		Disabled bool            `json:"d"`
		Runtime  bool            `json:"r"`
	}
	members := make([]sealedMember, 0, len(board.Members))
	for _, member := range board.Members {
		members = append(members, sealedMember{member.Key, member.Priority, member.Weights, member.KeyCount, member.IsDisabled, member.IsRuntimeOnly})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].Key < members[j].Key })
	raw, _ := json.Marshal(struct {
		Settings management.RoutingSettings `json:"s"`
		Members  []sealedMember             `json:"m"`
		Partial  []string                   `json:"x"`
	}{board.Settings, members, board.Partial})
	sum := sha256.Sum256(raw)
	board.Revision = hex.EncodeToString(sum[:])
}

func (board RoutingBoard) Member(key string) (RoutingMember, bool) {
	for _, member := range board.Members {
		if member.Key == key {
			return member, true
		}
	}
	return RoutingMember{}, false
}

type RoutingWeightEdit struct {
	Index int `json:"index"`
	// Weight nil clears the key's own weight, so CPA runs it as 1.
	Weight *int64 `json:"weight"`
}

type RoutingMemberEdit struct {
	Key      string              `json:"key"`
	Priority *int                `json:"priority,omitempty"`
	Weights  []RoutingWeightEdit `json:"weights,omitempty"`
}

// RoutingSettingsEdit names only the settings a plan changes; an absent field is
// left as it is. An empty session-affinity TTL removes it, so CPA uses its default.
type RoutingSettingsEdit struct {
	Strategy                      *string `json:"strategy,omitempty"`
	SessionAffinity               *bool   `json:"session_affinity,omitempty"`
	SessionAffinityTTL            *string `json:"session_affinity_ttl,omitempty"`
	RequestRetry                  *int64  `json:"request_retry,omitempty"`
	MaxRetryCredentials           *int64  `json:"max_retry_credentials,omitempty"`
	MaxRetryInterval              *int64  `json:"max_retry_interval,omitempty"`
	DisableCooling                *bool   `json:"disable_cooling,omitempty"`
	TransientErrorCooldownSeconds *int64  `json:"transient_error_cooldown_seconds,omitempty"`
}

// RoutingPlan is an arrangement prepared against the board revision it quotes.
type RoutingPlan struct {
	Revision string              `json:"revision"`
	Settings RoutingSettingsEdit `json:"settings,omitempty"`
	Members  []RoutingMemberEdit `json:"members,omitempty"`
}

// NormalizedRoutingPlan is a validated plan. Settings are keyed as in
// management.RoutingSettings and canonical: a strategy in CPA's own spelling, and
// a cleared session-affinity TTL as nil, which removes the key.
type NormalizedRoutingPlan struct {
	Revision string
	Settings map[string]any
	Members  []RoutingMemberEdit
}

// Routing result states. A config change set is not an upstream transaction, so
// a write that stopped partway is reported as uncertain rather than undone.
const (
	ROUTING_APPLIED       = "applied"
	ROUTING_FAILED        = "failed"
	ROUTING_UNCERTAIN     = "uncertain"
	ROUTING_NOT_ATTEMPTED = "not_attempted"
	// ROUTING_SETTINGS_KEY is the result address of the gateway-wide settings.
	ROUTING_SETTINGS_KEY = "settings"
)

type RoutingResult struct {
	Key    string `json:"key"`
	Status string `json:"status"`
	Code   string `json:"code,omitempty"`
}

type RoutingOutcome struct {
	// IsComplete is true only when every requested change was applied.
	IsComplete bool            `json:"is_complete"`
	Results    []RoutingResult `json:"results"`
	// Board is the arrangement read back after the writes; nil when that read failed.
	Board *RoutingBoard `json:"board,omitempty"`
}

// NormalizeRoutingPlan validates a plan's shape and settings without reading the board.
func NormalizeRoutingPlan(plan RoutingPlan) (NormalizedRoutingPlan, error) {
	if strings.TrimSpace(plan.Revision) == "" {
		return NormalizedRoutingPlan{}, invalidParameters{"revision is required"}
	}
	if len(plan.Members) > MAX_ROUTING_MEMBERS {
		return NormalizedRoutingPlan{}, invalidParameters{"too many members in one plan"}
	}
	settings, err := normalizeRoutingSettings(plan.Settings)
	if err != nil {
		return NormalizedRoutingPlan{}, err
	}
	seen := map[string]bool{}
	for _, edit := range plan.Members {
		if edit.Key == "" || seen[edit.Key] {
			return NormalizedRoutingPlan{}, invalidParameters{"each member must be named once"}
		}
		seen[edit.Key] = true
		if edit.Priority != nil && (*edit.Priority < math.MinInt32 || *edit.Priority > math.MaxInt32) {
			return NormalizedRoutingPlan{}, invalidParameters{"priority is out of range for " + edit.Key}
		}
		indexes := map[int]bool{}
		for _, weight := range edit.Weights {
			if weight.Index < 0 || indexes[weight.Index] {
				return NormalizedRoutingPlan{}, invalidParameters{"each weight must name one key of " + edit.Key}
			}
			indexes[weight.Index] = true
			if weight.Weight != nil && (*weight.Weight < 0 || *weight.Weight > ROUTING_WEIGHT_MAX) {
				return NormalizedRoutingPlan{}, invalidParameters{"weight must be between 0 and 1000000 for " + edit.Key}
			}
		}
	}
	return NormalizedRoutingPlan{Revision: plan.Revision, Settings: settings, Members: plan.Members}, nil
}

func normalizeRoutingSettings(edit RoutingSettingsEdit) (map[string]any, error) {
	settings := map[string]any{}
	if edit.Strategy != nil {
		strategy, known := normalizeRoutingStrategy(*edit.Strategy)
		if !known {
			return nil, invalidParameters{"strategy must be round-robin, weighted-round-robin or fill-first"}
		}
		settings["strategy"] = strategy
	}
	if edit.SessionAffinity != nil {
		settings["session_affinity"] = *edit.SessionAffinity
	}
	if edit.SessionAffinityTTL != nil {
		ttl := strings.TrimSpace(*edit.SessionAffinityTTL)
		if ttl == "" {
			settings["session_affinity_ttl"] = nil
		} else if duration, err := time.ParseDuration(ttl); err != nil || duration <= 0 {
			return nil, invalidParameters{"session_affinity_ttl must be a duration such as 1h"}
		} else {
			settings["session_affinity_ttl"] = ttl
		}
	}
	for key, value := range map[string]*int64{
		"request_retry":         edit.RequestRetry,
		"max_retry_credentials": edit.MaxRetryCredentials,
		"max_retry_interval":    edit.MaxRetryInterval,
	} {
		if value == nil {
			continue
		}
		if *value < 0 {
			return nil, invalidParameters{key + " must not be negative"}
		}
		settings[key] = *value
	}
	if edit.DisableCooling != nil {
		settings["disable_cooling"] = *edit.DisableCooling
	}
	if edit.TransientErrorCooldownSeconds != nil {
		// -1 turns the cooldown off and 0 keeps CPA's built-in one.
		if *edit.TransientErrorCooldownSeconds < -1 {
			return nil, invalidParameters{"transient_error_cooldown_seconds must be -1 or more"}
		}
		settings["transient_error_cooldown_seconds"] = *edit.TransientErrorCooldownSeconds
	}
	return settings, nil
}

// RoutingSettingValue reads one setting of the board by its plan name, so a plan
// can drop the settings that already hold the requested value.
func RoutingSettingValue(settings management.RoutingSettings, key string) any {
	switch key {
	case "strategy":
		return settings.Strategy
	case "session_affinity":
		return settings.SessionAffinity
	case "session_affinity_ttl":
		if settings.SessionAffinityTTL == "" {
			return nil
		}
		return settings.SessionAffinityTTL
	case "request_retry":
		return settings.RequestRetry
	case "max_retry_credentials":
		return settings.MaxRetryCredentials
	case "max_retry_interval":
		return settings.MaxRetryInterval
	case "disable_cooling":
		return settings.DisableCooling
	case "transient_error_cooldown_seconds":
		return settings.TransientErrorCooldownSeconds
	default:
		return nil
	}
}

// routingPreviewChange is one line of what a plan would change, named for a reader.
type routingPreviewChange struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Field string `json:"field"`
	From  any    `json:"from"`
	To    any    `json:"to"`
}

// previewRoutingPlan lists the changes a plan makes against the board, dropping the
// values it already holds.
func previewRoutingPlan(board RoutingBoard, plan NormalizedRoutingPlan) ([]routingPreviewChange, error) {
	changes := make([]routingPreviewChange, 0)
	for _, key := range management.RoutingSettingKeys() {
		value, isSet := plan.Settings[key]
		if !isSet {
			continue
		}
		if current := RoutingSettingValue(board.Settings, key); current != value {
			changes = append(changes, routingPreviewChange{Key: ROUTING_SETTINGS_KEY, Name: key, Field: key, From: current, To: value})
		}
	}
	for _, edit := range plan.Members {
		member, ok := board.Member(edit.Key)
		if !ok {
			return nil, ErrRoutingConflict
		}
		if edit.Priority != nil && *edit.Priority != member.Priority {
			if member.IsRuntimeOnly {
				return nil, invalidParameters{edit.Key + " is runtime-only and cannot have its priority changed"}
			}
			changes = append(changes, routingPreviewChange{Key: member.Key, Name: member.Name, Field: "priority", From: member.Priority, To: *edit.Priority})
		}
		for _, weight := range edit.Weights {
			if weight.Index >= len(member.Weights) {
				return nil, ErrRoutingConflict
			}
			current := member.Weights[weight.Index].Weight
			if (current == nil) != (weight.Weight == nil) || (current != nil && *current != *weight.Weight) {
				changes = append(changes, routingPreviewChange{Key: member.Key, Name: member.Name, Field: "weight", From: current, To: weight.Weight})
			}
		}
	}
	if len(changes) == 0 {
		return nil, ErrRoutingNoChanges
	}
	return changes, nil
}

func (s *Service) registerRouting(registry *capability.Registry) error {
	if err := read(registry, "routing_read", "Read CPA's routing board: every schedulable provider key and OAuth credential with its priority, weights and state, and the routing settings. Higher priority serves first; peers share by strategy, weight only under weighted-round-robin. The revision is what routing_apply quotes.", func(ctx context.Context, _ Empty) (RoutingBoard, error) {
		if s.ReadRouting == nil {
			return RoutingBoard{}, errors.New("unavailable")
		}
		board, err := s.ReadRouting(ctx)
		if len(board.Members) > MAX_ROUTING_MEMBERS {
			return RoutingBoard{}, errors.New("tool_result_too_large")
		}
		return board, err
	}); err != nil {
		return err
	}
	metadata := Meta("routing_apply", "Apply a routing plan from routing_read: new priorities and weights for named members (key from the board) and changed routing settings. Moving a member to a priority above every other makes it serve first. Writes CPA configuration after a backup; credentials are updated one by one.", "write", "high")
	metadata.Invalidates = []string{"management-routing", "management-providers", "management-auth-files", "providers"}
	return capability.Register(registry, metadata, func(ctx context.Context, input RoutingPlan) (capability.Preview, error) {
		plan, err := NormalizeRoutingPlan(input)
		if err != nil {
			return capability.Preview{}, err
		}
		if s.ReadRouting == nil {
			return capability.Preview{}, errors.New("unavailable")
		}
		board, err := s.ReadRouting(ctx)
		if err != nil {
			return capability.Preview{}, err
		}
		if board.Revision != plan.Revision {
			return capability.Preview{}, ErrRoutingConflict
		}
		changes, err := previewRoutingPlan(board, plan)
		if err != nil {
			return capability.Preview{}, err
		}
		return capability.Preview{Target: "routing", Revision: board.Revision, Changes: map[string]any{"changes": changes}}, nil
	}, func(ctx context.Context, input RoutingPlan, revision, _ string) (RoutingOutcome, error) {
		// The plan executes against the revision its preview was approved on.
		input.Revision = revision
		plan, err := NormalizeRoutingPlan(input)
		if err != nil {
			return RoutingOutcome{}, err
		}
		if s.ApplyRouting == nil {
			return RoutingOutcome{}, errors.New("unavailable")
		}
		return s.ApplyRouting(ctx, plan)
	})
}
