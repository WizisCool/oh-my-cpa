package warmup

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

var (
	specWords = []string{"flash", "lite", "mini", "nano", "small", "turbo", "haiku"}
	specRegex = func() []*regexp.Regexp {
		out := make([]*regexp.Regexp, len(specWords))
		for i, word := range specWords {
			out[i] = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])` + word + `(?:$|[^a-z0-9])`)
		}
		return out
	}()
	clockPattern = regexp.MustCompile(`^(\d{2}):(\d{2})$`)
	// The families known to answer with an image rather than words. A warmup request is a text
	// completion, so one of these can neither run it nor be the model Auto picks.
	imageModelPattern = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])(?:image|imagen|dall-?e|flux|stable-diffusion|sdxl|seedream|ideogram|midjourney|nano-banana)(?:[^a-z0-9]|$)`)
)

func lastSegment(id string) string {
	idx := strings.LastIndexByte(id, '/')
	if idx >= 0 {
		return id[idx+1:]
	}
	return id
}

func specTier(id string) int {
	name := lastSegment(id)
	for i, re := range specRegex {
		if re.MatchString(name) {
			return i
		}
	}
	return len(specWords)
}

// compareNaturalFold compares two strings case-insensitively with numeric-aware chunk ordering.
func compareNaturalFold(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	ia, ib := 0, 0
	for ia < len(ra) && ib < len(rb) {
		da := unicode.IsDigit(ra[ia])
		db := unicode.IsDigit(rb[ib])
		if da && db {
			sa, sb := ia, ib
			for ia < len(ra) && unicode.IsDigit(ra[ia]) {
				ia++
			}
			for ib < len(rb) && unicode.IsDigit(rb[ib]) {
				ib++
			}
			na := strings.TrimLeft(string(ra[sa:ia]), "0")
			nb := strings.TrimLeft(string(rb[sb:ib]), "0")
			if len(na) != len(nb) {
				if len(na) < len(nb) {
					return -1
				}
				return 1
			}
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			continue
		}
		ca := unicode.ToLower(ra[ia])
		cb := unicode.ToLower(rb[ib])
		if ca != cb {
			if ca < cb {
				return -1
			}
			return 1
		}
		ia++
		ib++
	}
	switch {
	case ia < len(ra):
		return 1
	case ib < len(rb):
		return -1
	default:
		return 0
	}
}

// isVersionedID reports whether an id's name segment carries a version or date number.
func isVersionedID(id string) bool {
	for _, r := range lastSegment(id) {
		if unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// Reached is the model a call point actually reaches: the upstream CPA resolves an alias to, or
// the call point itself when no rule renames it.
func Reached(callPoint string, upstream map[string]string) string {
	if target := strings.TrimSpace(upstream[callPoint]); target != "" {
		return target
	}
	return callPoint
}

// SortModelsForAuto orders a credential's call points by the lightness of the model each one
// reaches (flash < lite < mini < nano < small < turbo < haiku), breaking ties by newer version
// first (descending natural sort on the last segment).
//
// upstream maps a call point to the upstream model CPA resolves it to. An OAuth model alias is a
// name the operator chose and says nothing about the model behind it, so ranking reads the
// upstream while the call point stays what is sent: with fork=false the upstream name itself is
// no longer callable. A call point missing from the map is its own upstream.
//
// Every model id is versioned, while a credential's list can also carry a name that reaches no
// model at all. The descending tie-break would rank such a name by its letters alone and could
// put it first, so versioned names come first and the unversioned answer is still returned when
// nothing else is listed.
func SortModelsForAuto(models []string, upstream map[string]string) []string {
	out := make([]string, 0, len(models))
	seen := make(map[string]struct{}, len(models))
	for _, raw := range models {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	rankName := func(callPoint string) string { return Reached(callPoint, upstream) }
	slices.SortFunc(out, func(a, b string) int {
		ra, rb := rankName(a), rankName(b)
		if va, vb := isVersionedID(ra), isVersionedID(rb); va != vb {
			if va {
				return -1
			}
			return 1
		}
		ta, tb := specTier(ra), specTier(rb)
		if ta != tb {
			return ta - tb
		}
		if order := compareNaturalFold(lastSegment(rb), lastSegment(ra)); order != 0 {
			return order
		}
		// Two call points reaching one upstream: the upstream's own name before an alias of it.
		return compareBool(a != ra, b != rb)
	})
	return out
}

func compareBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case a:
		return 1
	default:
		return -1
	}
}

// FilterWarmupModels drops the image-generation models from a credential's call points. A call
// point is judged by the model it reaches, so an alias that names an image model is dropped too.
func FilterWarmupModels(models []string, upstream map[string]string) []string {
	kept := make([]string, 0, len(models))
	for _, model := range models {
		if !imageModelPattern.MatchString(lastSegment(Reached(model, upstream))) {
			kept = append(kept, model)
		}
	}
	return kept
}

// PickAutoModel selects the call point that reaches the lightest model; see SortModelsForAuto.
func PickAutoModel(models []string, upstream map[string]string) string {
	sorted := SortModelsForAuto(models, upstream)
	if len(sorted) == 0 {
		return ""
	}
	return sorted[0]
}

// ResolveModel returns the task's configured model, or the account's resolved auto model when empty.
func ResolveModel(task Task, account *CatalogAccount) string {
	if explicit := strings.TrimSpace(task.Model); explicit != "" {
		return explicit
	}
	if account == nil {
		return ""
	}
	return account.AutoModel
}

func ParseClock(clock string) (int, int, bool) {
	m := clockPattern.FindStringSubmatch(strings.TrimSpace(clock))
	if m == nil {
		return 0, 0, false
	}
	hour, err1 := strconv.Atoi(m[1])
	minute, err2 := strconv.Atoi(m[2])
	if err1 != nil || err2 != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, 0, false
	}
	return hour, minute, true
}

func ValidTimeZone(tz string) bool {
	trimmed := strings.TrimSpace(tz)
	if trimmed == "" {
		return false
	}
	_, err := time.LoadLocation(trimmed)
	return err == nil
}

func ParseISO(raw string) (time.Time, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse(time.RFC3339, trimmed); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func FormatISO(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func zonedDayTime(year int, month time.Month, day, hour, minute int, loc *time.Location) time.Time {
	targetUTC := time.Date(year, month, day, hour, minute, 0, 0, time.UTC)
	guess := targetUTC
	for range 4 {
		p := guess.In(loc)
		asUTC := time.Date(p.Year(), p.Month(), p.Day(), p.Hour(), p.Minute(), p.Second(), 0, time.UTC)
		diff := targetUTC.Sub(asUTC)
		if diff == 0 {
			return guess.UTC()
		}
		guess = guess.Add(diff)
	}
	return guess.UTC()
}

// NextDaily computes the next daily trigger instant strictly after `after`.
func NextDaily(after time.Time, clockStr, timeZone string) (time.Time, bool) {
	hour, minute, ok := ParseClock(clockStr)
	if !ok {
		return time.Time{}, false
	}
	loc, err := time.LoadLocation(strings.TrimSpace(timeZone))
	if err != nil {
		return time.Time{}, false
	}
	start := after.In(loc)
	for offset := 0; offset <= 7; offset++ {
		day := time.Date(start.Year(), start.Month(), start.Day()+offset, 12, 0, 0, 0, time.UTC)
		candidate := zonedDayTime(day.Year(), day.Month(), day.Day(), hour, minute, loc)
		if candidate.After(after) {
			return candidate, true
		}
	}
	return time.Time{}, false
}

// NextEvery computes the next fixed-interval trigger instant strictly after `after`.
func NextEvery(after time.Time, hours int, anchorISO string) (time.Time, bool) {
	if hours < MIN_EVERY_HOURS || hours > MAX_EVERY_HOURS {
		return time.Time{}, false
	}
	anchor, ok := ParseISO(anchorISO)
	if !ok {
		return time.Time{}, false
	}
	step := time.Duration(hours) * time.Hour
	if !after.After(anchor) {
		return anchor, true
	}
	steps := after.Sub(anchor)/step + 1
	return anchor.Add(steps * step).UTC(), true
}

// LastDue returns the most recent scheduled due instant at or before `now` for daily and every triggers.
func LastDue(now time.Time, trigger Trigger) (time.Time, bool) {
	switch trigger.Kind {
	case "daily":
		cursor := now.Add(-DAILY_LOOKBACK)
		var last time.Time
		hasLast := false
		for range 8 {
			next, ok := NextDaily(cursor, trigger.Time, trigger.TimeZone)
			if !ok || next.After(now) {
				break
			}
			last = next
			hasLast = true
			cursor = next
		}
		return last, hasLast
	case "every":
		if trigger.Hours < MIN_EVERY_HOURS || trigger.Hours > MAX_EVERY_HOURS {
			return time.Time{}, false
		}
		anchor, ok := ParseISO(trigger.Anchor)
		if !ok || now.Before(anchor) {
			return time.Time{}, false
		}
		step := time.Duration(trigger.Hours) * time.Hour
		steps := now.Sub(anchor) / step
		return anchor.Add(steps * step).UTC(), true
	default:
		return time.Time{}, false
	}
}

func hourFloorISO(t time.Time) string {
	u := t.UTC()
	floored := time.Date(u.Year(), u.Month(), u.Day(), u.Hour(), 0, 0, 0, time.UTC)
	return FormatISO(floored)
}

// WindowDue evaluates when a quota window is due for warmup.
// An idle window (no resets_at, or resets_at <= snapshot_at) is due immediately at most once per hour.
// An active window is due 30s after resets_at.
func WindowDue(window *QuotaWindow, snapshotAt string) *WindowDueResult {
	if window == nil {
		return nil
	}
	if strings.TrimSpace(window.ResetsAt) == "" {
		snap, ok := ParseISO(snapshotAt)
		if !ok {
			return nil
		}
		return &WindowDueResult{
			At:       FormatISO(snap),
			ResetKey: "idle:" + hourFloorISO(snap),
			Idle:     true,
		}
	}
	resetAt, ok := ParseISO(window.ResetsAt)
	if !ok {
		return nil
	}
	if snap, ok := ParseISO(snapshotAt); ok && !resetAt.After(snap) {
		return &WindowDueResult{
			At:       FormatISO(snap),
			ResetKey: "idle:" + hourFloorISO(snap),
			Idle:     true,
		}
	}
	return &WindowDueResult{
		At:       FormatISO(resetAt.Add(WINDOW_GRACE)),
		ResetKey: FormatISO(resetAt),
		Idle:     false,
	}
}

// FindAccountWindow finds a matching quota window on an account, treating "seven_day" and "weekly" as synonyms.
func FindAccountWindow(account *CatalogAccount, windowID string) *QuotaWindow {
	if account == nil || windowID == "" {
		return nil
	}
	for i := range account.Windows {
		if account.Windows[i].ID == windowID {
			return &account.Windows[i]
		}
	}
	if windowID == "seven_day" || windowID == "weekly" {
		alt := "weekly"
		if windowID == "weekly" {
			alt = "seven_day"
		}
		for i := range account.Windows {
			if account.Windows[i].ID == alt {
				return &account.Windows[i]
			}
		}
	}
	return nil
}

// CurrentWindowDue computes the effective window due state for a task given account quota and persisted marks.
func CurrentWindowDue(task Task, account *CatalogAccount, marks TaskMarks, now time.Time) *WindowDueResult {
	if task.Trigger.Kind != "window" || account == nil || strings.TrimSpace(account.SnapshotAt) == "" {
		return nil
	}
	win := FindAccountWindow(account, task.Trigger.Window)
	if win == nil {
		return nil
	}
	due := WindowDue(win, account.SnapshotAt)
	if due == nil {
		return nil
	}
	if due.Idle {
		if sentAt, ok1 := ParseISO(marks.LastSent); ok1 {
			if snapAt, ok2 := ParseISO(account.SnapshotAt); ok2 && snapAt.Sub(sentAt) < POST_SEND_SETTLE {
				return nil
			}
		}
		if lastResetAt, ok := ParseISO(marks.LastReset); ok && lastResetAt.After(now) {
			return nil
		}
	}
	return due
}

// Upcoming returns the next `count` trigger timestamps as ISO strings.
func Upcoming(trigger Trigger, window *QuotaWindow, now time.Time, count int) []string {
	if count <= 0 {
		count = 3
	}
	if trigger.Kind == "window" {
		if window == nil || strings.TrimSpace(window.ResetsAt) == "" {
			return []string{}
		}
		due := WindowDue(window, FormatISO(now))
		if due == nil || due.Idle {
			return []string{}
		}
		return []string{due.At}
	}
	out := make([]string, 0, count)
	cursor := now.Add(-time.Millisecond)
	for range count {
		var next time.Time
		var ok bool
		switch trigger.Kind {
		case "daily":
			next, ok = NextDaily(cursor, trigger.Time, trigger.TimeZone)
		case "every":
			next, ok = NextEvery(cursor, trigger.Hours, trigger.Anchor)
		}
		if !ok {
			break
		}
		out = append(out, FormatISO(next))
		cursor = next
	}
	return out
}

// ValidateTask checks whether a TaskInput has valid provider, credential, and trigger settings.
func ValidateTask(input TaskInput) error {
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	if provider == "" {
		return errors.New("invalid_provider")
	}
	if strings.TrimSpace(input.AuthIndex) == "" && strings.TrimSpace(input.Account) == "" {
		return errors.New("missing_account")
	}
	switch input.Trigger.Kind {
	case "window":
		if strings.TrimSpace(input.Trigger.Window) == "" {
			return errors.New("missing_window")
		}
	case "daily":
		if _, _, ok := ParseClock(input.Trigger.Time); !ok {
			return errors.New("invalid_daily_time")
		}
		if !ValidTimeZone(input.Trigger.TimeZone) {
			return errors.New("invalid_timezone")
		}
	case "every":
		if input.Trigger.Hours < MIN_EVERY_HOURS || input.Trigger.Hours > MAX_EVERY_HOURS {
			return errors.New("invalid_interval_hours")
		}
		if _, ok := ParseISO(input.Trigger.Anchor); !ok {
			return errors.New("invalid_anchor")
		}
	default:
		return errors.New("invalid_trigger_kind")
	}
	return nil
}

// DefaultTaskName synthesizes a concise task name when the caller leaves Name blank.
func DefaultTaskName(input TaskInput) string {
	if trimmed := strings.TrimSpace(input.Name); trimmed != "" {
		return trimmed
	}
	target := strings.TrimSpace(input.Account)
	if target == "" {
		target = strings.TrimSpace(input.AuthIndex)
	}
	if target == "" {
		target = strings.TrimSpace(input.Provider)
	}
	// The trigger reads as a parenthetical on the credential, "claude.json (08:55)", so the stored
	// name is one phrase rather than two values strung on a separator.
	switch input.Trigger.Kind {
	case "window":
		return fmt.Sprintf("%s (%s)", target, input.Trigger.Window)
	case "daily":
		return fmt.Sprintf("%s (%s)", target, input.Trigger.Time)
	case "every":
		return fmt.Sprintf("%s (%dh)", target, input.Trigger.Hours)
	default:
		return target
	}
}
