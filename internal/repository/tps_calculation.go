package repository

import (
	"context"
	"encoding/json"
)

type TpsCalculationMode string

const (
	TpsExcludeTTFT TpsCalculationMode = "exclude_ttft"
	TpsIncludeTTFT TpsCalculationMode = "include_ttft"
)

// ReadTpsCalculationMode preserves the historical denominator for absent or unsupported preferences.
func (r *Repository) ReadTpsCalculationMode(ctx context.Context) (TpsCalculationMode, error) {
	raw, _, err := r.GetPreference(ctx, PreferenceTpsCalculationMode)
	if err != nil {
		return "", err
	}
	var mode TpsCalculationMode
	if json.Unmarshal([]byte(raw), &mode) != nil || (mode != TpsExcludeTTFT && mode != TpsIncludeTTFT) {
		mode = TpsExcludeTTFT
	}
	return mode, nil
}
