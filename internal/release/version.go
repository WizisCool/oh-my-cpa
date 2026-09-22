// Package release observes the published versions of Oh My CPA and the gateway it
// manages, and reports what changed between the version running here and the newest
// release.
//
// It exists because the console previously answered two different questions with
// one comparison. "Is my version the same string as the newest one" is not the same
// question as "is a newer version available": a string comparison reports an update
// whenever the strings differ, in either direction, and reports "up to date" when
// a check failed. Both are wrong in ways the operator cannot see.
package release

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Update states. The three-state answer is deliberate: "I could not tell" is a
// real outcome here, because the running build may be a development or fork build
// whose version is not on the release line at all, and reporting such a build as
// "up to date" is a claim the data does not support.
const (
	// UpdateAvailable means a newer release than the running version exists.
	UpdateAvailable = "update_available"
	// UpToDate means the running version is the newest release.
	UpToDate = "up_to_date"
	// UpdateAhead means the running version is newer than any release - a build
	// ahead of publication, not an update to install.
	UpdateAhead = "update_ahead"
	// UpdateIndeterminate means no comparison could be made, and Why says why.
	UpdateIndeterminate = "indeterminate"
)

// Reasons a comparison came out indeterminate. They are separate values rather than
// one "unknown" because the page's copy differs: a development build is normal,
// whereas a failed check is something the operator may want to act on.
const (
	ReasonCurrentNotComparable = "running_version_not_comparable"
	ReasonLatestNotComparable  = "newest_release_not_comparable"
	ReasonNoReleases           = "no_releases_published"
	ReasonNoData               = "not_checked_yet"
)

// Version is a parsed release version.
//
// Only plain dotted numeric versions parse. A trailing suffix - `-dev`, `-demo`,
// `-rc1` - makes the version incomparable on purpose rather than being ignored:
// `v0.1.0-dev` is not the same claim about the world as `v0.1.0`, and pretending
// otherwise would let a development build be announced as "up to date" with a
// release it does not correspond to.
type Version struct {
	components []int
	original   string
}

// ParseVersion parses a release version, accepting an optional leading "v".
func ParseVersion(raw string) (Version, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return Version{}, errors.New("version is empty")
	}
	core := strings.TrimPrefix(strings.TrimPrefix(trimmed, "v"), "V")
	// Any suffix at all - pre-release, build metadata, a fork's own marker - puts
	// the value outside the release line this comparison is about.
	if strings.ContainsAny(core, "-+_ ") {
		return Version{}, fmt.Errorf("version %q carries a suffix and is not a release version", raw)
	}
	parts := strings.Split(core, ".")
	if len(parts) == 0 {
		return Version{}, fmt.Errorf("version %q has no components", raw)
	}
	components := make([]int, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			return Version{}, fmt.Errorf("version %q has an empty component", raw)
		}
		value, err := strconv.Atoi(part)
		if err != nil {
			return Version{}, fmt.Errorf("version %q has a non-numeric component %q", raw, part)
		}
		if value < 0 {
			return Version{}, fmt.Errorf("version %q has a negative component", raw)
		}
		components = append(components, value)
	}
	return Version{components: components, original: trimmed}, nil
}

// String returns the version as it was written.
func (v Version) String() string { return v.original }

// Compare orders two versions, padding the shorter with zeros so that `7.3` and
// `7.3.0` are the same version rather than different ones.
func (v Version) Compare(other Version) int {
	length := len(v.components)
	if len(other.components) > length {
		length = len(other.components)
	}
	for index := 0; index < length; index++ {
		left := v.component(index)
		right := other.component(index)
		if left != right {
			if left < right {
				return -1
			}
			return 1
		}
	}
	return 0
}

func (v Version) component(index int) int {
	if index < len(v.components) {
		return v.components[index]
	}
	return 0
}

// Comparison is the answer the page renders.
type Comparison struct {
	// State is one of the Update* constants.
	State string
	// Why is set when State is UpdateIndeterminate, naming the reason so the copy
	// can differ between "you are on a development build" and "the check failed".
	Why string
	// RunningVersion and LatestVersion are the values compared, echoed for display.
	RunningVersion string
	LatestVersion  string
}

// Newer reports whether an update is available.
func (c Comparison) Newer() bool { return c.State == UpdateAvailable }

// CompareVersions answers "is there a newer release than the running version".
//
// `latest` is the newest release the feed reported. An empty latest is not an
// error state to hide: it means nothing has been published (or nothing has been
// fetched yet), and the caller distinguishes those two with Why.
func CompareVersions(running, latest string) Comparison {
	comparison := Comparison{RunningVersion: strings.TrimSpace(running), LatestVersion: strings.TrimSpace(latest)}
	if comparison.LatestVersion == "" {
		comparison.State = UpdateIndeterminate
		comparison.Why = ReasonNoReleases
		return comparison
	}
	runningParsed, runningErr := ParseVersion(comparison.RunningVersion)
	if runningErr != nil {
		comparison.State = UpdateIndeterminate
		comparison.Why = ReasonCurrentNotComparable
		return comparison
	}
	latestParsed, latestErr := ParseVersion(comparison.LatestVersion)
	if latestErr != nil {
		comparison.State = UpdateIndeterminate
		comparison.Why = ReasonLatestNotComparable
		return comparison
	}
	switch runningParsed.Compare(latestParsed) {
	case -1:
		comparison.State = UpdateAvailable
	case 0:
		comparison.State = UpToDate
	default:
		comparison.State = UpdateAhead
	}
	return comparison
}

// rangeCandidate is one release considered for the merged change log.
type rangeCandidate struct {
	Tag        string
	Prerelease bool
}

// SelectRange returns the versions whose notes belong in a merged change log:
// every stable release newer than `running` and not newer than `latest`.
//
// Two limits are deliberate. Prereleases are excluded because a stable operator
// upgrading does not experience them, and including them would describe a build
// that was never offered. The upper bound is `latest` rather than "everything the
// feed has" so that a feed publishing a backport for an older line cannot insert
// notes the operator will never receive.
//
// An incomparable running version returns no elements rather than guessing: the
// console shows the newest release's notes alone in that case, without claiming a
// range it cannot compute. That is why the caller is handed an explicit empty
// result, and why it is documented rather than signalled with an error.
func SelectRange(candidates []rangeCandidate, running, latest string) []string {
	runningParsed, err := ParseVersion(running)
	if err != nil {
		return nil
	}
	latestParsed, err := ParseVersion(latest)
	if err != nil {
		return nil
	}
	if runningParsed.Compare(latestParsed) >= 0 {
		return nil
	}
	selected := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Prerelease {
			continue
		}
		parsed, err := ParseVersion(candidate.Tag)
		if err != nil {
			continue
		}
		if parsed.Compare(runningParsed) > 0 && parsed.Compare(latestParsed) <= 0 {
			selected = append(selected, candidate.Tag)
		}
	}
	return selected
}

// SortTagsDescending orders tags newest-first by version, tie-broken by the tag
// text so the order is stable.
//
// Version order is used rather than the feed's order because a feed lists releases
// by publication time, and a backport published after a newer release would then
// appear above it.
func SortTagsDescending(tags []string) []string {
	sorted := make([]string, len(tags))
	copy(sorted, tags)
	for index := 1; index < len(sorted); index++ {
		for scan := index; scan > 0; scan-- {
			if compareTagStrings(sorted[scan-1], sorted[scan]) >= 0 {
				break
			}
			sorted[scan-1], sorted[scan] = sorted[scan], sorted[scan-1]
		}
	}
	return sorted
}

func compareTagStrings(left, right string) int {
	leftParsed, leftErr := ParseVersion(left)
	rightParsed, rightErr := ParseVersion(right)
	switch {
	case leftErr == nil && rightErr == nil:
		return leftParsed.Compare(rightParsed)
	case leftErr == nil:
		// A comparable version outranks an unparsable tag, which is the only
		// ordering available for something like a named release.
		return 1
	case rightErr == nil:
		return -1
	default:
		return strings.Compare(left, right)
	}
}
