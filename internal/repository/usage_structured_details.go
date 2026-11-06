package repository

import (
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

type structuredUsageValue struct{ details *usage.StructuredUsageDetails }

func (value structuredUsageValue) Value() (driver.Value, error) {
	encoded, err := usage.EncodeStructuredUsage(value.details)
	if err != nil {
		return nil, fmt.Errorf("encode structured usage: %w", err)
	}
	if encoded == "" {
		return nil, nil
	}
	return encoded, nil
}

func decodeStoredStructuredUsage(stored sql.NullString) (*usage.StructuredUsageDetails, error) {
	if !stored.Valid {
		return nil, nil
	}
	var details usage.StructuredUsageDetails
	if err := json.Unmarshal([]byte(stored.String), &details); err != nil {
		return nil, fmt.Errorf("read stored structured usage: %w", err)
	}
	return usage.SanitizeStructuredUsage(&details), nil
}
