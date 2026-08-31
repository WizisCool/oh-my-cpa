package domain

import "time"

type ResourceStatus string

const (
	ResourceStatusUnclaimed ResourceStatus = "unclaimed"
	ResourceStatusClaimed   ResourceStatus = "claimed"
	ResourceStatusIgnored   ResourceStatus = "ignored"
	ResourceStatusMissing   ResourceStatus = "missing"
)

func (s ResourceStatus) Valid() bool {
	switch s {
	case ResourceStatusUnclaimed, ResourceStatusClaimed, ResourceStatusIgnored, ResourceStatusMissing:
		return true
	default:
		return false
	}
}

type CPAInstance struct {
	ID                      string
	Name                    string
	BaseURL                 string
	UsageAddr               string
	ManagementKeyCiphertext []byte
	ManagementKeyNonce      []byte
	Status                  string
	LastSeenAt              *time.Time
	LastError               string
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

type DiscoveredResource struct {
	ID              string
	InstanceID      string
	ResourceKey     string
	CPAResourceType string
	CPAAuthIndex    string
	CPAResourceName string
	CPADriver       string
	ProtocolDriver  string
	ProtocolDisplay string
	BaseURL         string
	SuggestedSource string
	SuggestedPlan   string
	Status          ResourceStatus
	LastSeenAt      time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
	Details         ResourceDetails

	// Effective user-facing fields are resolved from resource_overrides.
	DisplayName       string
	CustomDisplayName *string
	IconRef           *string
	Color             *string
	Notes             *string
}

type ResourceDetails struct {
	Models      []string          `json:"models,omitempty"`
	AuthType    string            `json:"auth_type,omitempty"`
	Email       string            `json:"email,omitempty"`
	SourceFile  string            `json:"source_file,omitempty"`
	Priority    int               `json:"priority,omitempty"`
	Prefix      string            `json:"prefix,omitempty"`
	Disabled    bool              `json:"disabled,omitempty"`
	Unavailable bool              `json:"unavailable,omitempty"`
	Extra       map[string]string `json:"extra,omitempty"`
}

type ResourceOverride struct {
	DisplayName    *string
	Color          *string
	IconRef        *string
	Notes          *string
	Status         *ResourceStatus
	DisplayNameSet bool
	ColorSet       bool
	IconRefSet     bool
	NotesSet       bool
	StatusSet      bool
}
