package warmup

import "time"

const (
	FIVE_HOUR_MS = int64((5 * time.Hour) / time.Millisecond)
	WEEK_MS      = int64((7 * 24 * time.Hour) / time.Millisecond)

	WINDOW_GRACE             = 30 * time.Second
	DAILY_LOOKBACK           = 48 * time.Hour
	POST_SEND_SETTLE         = 60 * time.Second
	SLIDING_CONFIRM_INTERVAL = 45 * time.Second
	SLIDING_DRIFT_TOLERANCE  = 15 * time.Second
	SLIDING_FIXED_TOLERANCE  = 5 * time.Second
	SLIDING_FULL_MARGIN      = 10 * time.Minute
	CARD_FRESH_AGE           = 60 * time.Second
	CATCHUP_LAG              = 90 * time.Second

	MIN_EVERY_HOURS   = 1
	MAX_EVERY_HOURS   = 168
	MAX_RUNS_PER_TASK = 50
	MAX_RESET_KEYS    = 20
	MAX_TIMELINE      = 20
)

type Trigger struct {
	Kind     string `json:"kind"`
	Window   string `json:"window,omitempty"`
	Time     string `json:"time,omitempty"`
	TimeZone string `json:"time_zone,omitempty"`
	Hours    int    `json:"hours,omitempty"`
	Anchor   string `json:"anchor,omitempty"`
}

type Task struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Enabled   bool    `json:"enabled"`
	Provider  string  `json:"provider"`
	AuthIndex string  `json:"auth_index"`
	Account   string  `json:"account"`
	Model     string  `json:"model"`
	Trigger   Trigger `json:"trigger"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type TaskInput struct {
	Name      string  `json:"name"`
	Enabled   bool    `json:"enabled"`
	Provider  string  `json:"provider"`
	AuthIndex string  `json:"auth_index"`
	Account   string  `json:"account"`
	Model     string  `json:"model"`
	Trigger   Trigger `json:"trigger"`
}

type TaskSaveInput struct {
	ID string `json:"id,omitempty"`
	TaskInput
}

type TaskIDInput struct {
	ID string `json:"id"`
}

type Run struct {
	ID           string `json:"id"`
	TaskID       string `json:"task_id"`
	TaskName     string `json:"task_name"`
	At           string `json:"at"`
	Outcome      string `json:"outcome"`
	Source       string `json:"source"`
	Provider     string `json:"provider"`
	AuthIndex    string `json:"auth_index"`
	Account      string `json:"account"`
	Model        string `json:"model"`
	MS           *int64 `json:"ms,omitempty"`
	Message      string `json:"message,omitempty"`
	Due          string `json:"due,omitempty"`
	ResetKey     string `json:"reset_key,omitempty"`
	InputTokens  *int64 `json:"input_tokens,omitempty"`
	OutputTokens *int64 `json:"output_tokens,omitempty"`
}

type TaskMarks struct {
	LastDue          string   `json:"last_due,omitempty"`
	ResetKeys        []string `json:"reset_keys,omitempty"`
	LastReset        string   `json:"last_reset,omitempty"`
	LastSent         string   `json:"last_sent,omitempty"`
	ObservedAt       string   `json:"observed_at,omitempty"`
	ObservedResetsAt string   `json:"observed_resets_at,omitempty"`
	ConfirmedReset   string   `json:"confirmed_reset,omitempty"`
	IsSlidingIdle    bool     `json:"sliding_idle,omitempty"`
}

type QuotaWindow struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	UsedPercent *float64 `json:"used_percent"`
	ResetsAt    string   `json:"resets_at,omitempty"`
	PeriodHours float64  `json:"-"`
}

type CatalogAccount struct {
	AuthIndex string `json:"auth_index"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	// OAuthProvider is the login portal that issued the credential, for a plugin that declares
	// several; a surface cannot draw the credential's brand without it.
	OAuthProvider string        `json:"oauth_provider,omitempty"`
	Email         string        `json:"email,omitempty"`
	Status        string        `json:"status,omitempty"`
	Disabled      bool          `json:"disabled,omitempty"`
	Models        []string      `json:"models"`
	AutoModel     string        `json:"auto_model"`
	Windows       []QuotaWindow `json:"windows"`
	SnapshotAt    string        `json:"snapshot_at,omitempty"`
}

type CatalogProvider struct {
	Provider string           `json:"provider"`
	Accounts []CatalogAccount `json:"accounts"`
}

type Catalog struct {
	Providers []CatalogProvider `json:"providers"`
	TimeZone  string            `json:"timezone"`
}

type TimelineEntry struct {
	TaskID   string `json:"task_id"`
	TaskName string `json:"task_name"`
	At       string `json:"at"`
	Account  string `json:"account"`
	Model    string `json:"model"`
}

type StateView struct {
	Tasks    []Task             `json:"tasks"`
	Runs     []Run              `json:"runs"`
	Next     map[string]*string `json:"next"`
	Timeline []TimelineEntry    `json:"timeline"`
	Catalog  *Catalog           `json:"catalog,omitempty"`
}

type RunResponse struct {
	Run   Run       `json:"run"`
	State StateView `json:"state"`
}

type WindowDueResult struct {
	At       string `json:"at"`
	ResetKey string `json:"reset_key"`
	Idle     bool   `json:"idle"`
}

type Outcome struct {
	Status       string `json:"status"`
	Reason       string `json:"reason,omitempty"`
	InputTokens  *int64 `json:"input_tokens,omitempty"`
	OutputTokens *int64 `json:"output_tokens,omitempty"`
}

// Window and Observation are retained for quota snapshot evidence parsing in internal/quota.
type Window struct {
	State       string   `json:"state"`
	UsedPercent *float64 `json:"used_percent,omitempty"`
	ResetAtMS   *int64   `json:"reset_at_ms,omitempty"`
	PeriodMS    int64    `json:"period_ms,omitempty"`
}

type Observation struct {
	Provider      string            `json:"provider"`
	ObservedAtMS  int64             `json:"observed_at_ms"`
	PaidFallback  string            `json:"paid_fallback"`
	PaidSource    string            `json:"paid_source,omitempty"`
	IsBlocked     bool              `json:"blocked,omitempty"`
	BlockedModels []string          `json:"blocked_models,omitempty"`
	FiveHour      Window            `json:"five_hour"`
	Weekly        Window            `json:"weekly"`
	ModelWindows  map[string]Window `json:"model_windows,omitempty"`
}
