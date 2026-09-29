package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/timezone"
)

const PreferenceTimezone = "omc_timezone"

type TimezoneInfo struct {
	Timezone          string `json:"timezone"`
	ServerTimezone    string `json:"server_timezone"`
	EffectiveTimezone string `json:"effective_timezone"`
}

func (r *Repository) Timezone() *timezone.Settings { return r.timezone }
func (r *Repository) LoadTimezone(ctx context.Context) error {
	if raw, exists := os.LookupEnv("TZ"); exists && raw != "" {
		name := strings.TrimPrefix(strings.TrimPrefix(raw, ":"), "/usr/share/zoneinfo/")
		if _, err := timezone.Load(name); err != nil {
			return fmt.Errorf("TZ must name an IANA timezone: %w", err)
		}
	}
	if _, err := timezone.Load(r.timezone.Server().String()); err != nil {
		return fmt.Errorf("cannot identify server timezone; set TZ to an IANA name: %w", err)
	}
	raw, exists, err := r.GetPreference(ctx, PreferenceTimezone)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	name, err := parseTimezone(raw)
	if err != nil {
		return err
	}
	return r.timezone.Set(name)
}
func parseTimezone(raw string) (string, error) {
	var name string
	if strings.TrimSpace(raw) == "null" || json.Unmarshal([]byte(raw), &name) != nil {
		return "", timezone.ErrInvalid
	}
	if name != "" {
		if _, err := timezone.Load(name); err != nil {
			return "", err
		}
	}
	return name, nil
}
func (r *Repository) ReadTimezone(ctx context.Context) (TimezoneInfo, error) {
	r.timezoneMu.Lock()
	defer r.timezoneMu.Unlock()
	raw, exists, err := r.GetPreference(ctx, PreferenceTimezone)
	if err != nil {
		return TimezoneInfo{}, err
	}
	name := ""
	if exists {
		name, err = parseTimezone(raw)
		if err != nil {
			return TimezoneInfo{}, err
		}
	}
	return TimezoneInfo{name, r.timezone.Server().String(), r.timezone.Location().String()}, nil
}
