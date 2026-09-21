package release

import "testing"

func TestParseVersionAcceptsReleaseVersionsOnly(t *testing.T) {
	// String echoes the version as it was written, minus surrounding whitespace. It is
	// used for display, so it must not silently rewrite the operator's own tag.
	accepted := map[string]string{
		"v7.3.11":  "v7.3.11",
		"7.3.11":   "7.3.11",
		"V7.3":     "V7.3",
		"v0.1.0":   "v0.1.0",
		"v10.0.0":  "v10.0.0",
		" v7.3.5 ": "v7.3.5",
	}
	for input, want := range accepted {
		parsed, err := ParseVersion(input)
		if err != nil {
			t.Errorf("ParseVersion(%q) failed: %v", input, err)
			continue
		}
		if parsed.String() != want {
			t.Errorf("ParseVersion(%q).String() = %q, want %q", input, parsed.String(), want)
		}
	}

	// A suffixed version is refused rather than trimmed. `v0.1.0-dev` is not a claim
	// equivalent to `v0.1.0`, and treating it as one would let a development build be
	// announced as up to date with a release it does not correspond to.
	refused := []string{
		"v0.1.0-dev",
		"v0.1.0-demo",
		"v8.0.0-rc1",
		"v1.2.3+build5",
		"v1.2.3_4",
		"latest",
		"unknown",
		"",
		"v",
		"v1..2",
		"v1.a",
	}
	for _, input := range refused {
		if parsed, err := ParseVersion(input); err == nil {
			t.Errorf("ParseVersion(%q) = %q, want an error", input, parsed.String())
		}
	}
}

func TestCompareVersionsCoversEveryState(t *testing.T) {
	cases := []struct {
		running string
		latest  string
		state   string
		why     string
	}{
		{"v7.3.5", "v7.3.11", UpdateAvailable, ""},
		{"v7.3.5", "v8.0.0", UpdateAvailable, ""},
		{"v7", "v7.0.1", UpdateAvailable, ""},
		{"v7.3.11", "v7.3.11", UpToDate, ""},
		// Padding means these are the same version, not two different ones.
		{"v7.3", "v7.3.0", UpToDate, ""},
		{"v7.3.0.0", "v7.3", UpToDate, ""},
		// A running version ahead of publication is its own state, not an update.
		{"v8.0.0", "v7.3.11", UpdateAhead, ""},
		{"v7.4.0", "v7.3.11", UpdateAhead, ""},
		// Incomparable inputs report why rather than guessing a direction.
		{"v0.1.0-dev", "v7.3.11", UpdateIndeterminate, ReasonCurrentNotComparable},
		{"unknown", "v7.3.11", UpdateIndeterminate, ReasonCurrentNotComparable},
		{"", "v7.3.11", UpdateIndeterminate, ReasonCurrentNotComparable},
		{"v7.3.5", "nightly", UpdateIndeterminate, ReasonLatestNotComparable},
		{"v7.3.5", "", UpdateIndeterminate, ReasonNoReleases},
		{"v0.1.0-dev", "", UpdateIndeterminate, ReasonNoReleases},
	}
	for _, testCase := range cases {
		comparison := CompareVersions(testCase.running, testCase.latest)
		if comparison.State != testCase.state {
			t.Errorf("CompareVersions(%q, %q).State = %q, want %q", testCase.running, testCase.latest, comparison.State, testCase.state)
		}
		if comparison.Why != testCase.why {
			t.Errorf("CompareVersions(%q, %q).Why = %q, want %q", testCase.running, testCase.latest, comparison.Why, testCase.why)
		}
	}
}

func TestSelectRangeCoversTheIntervalBetweenTwoVersions(t *testing.T) {
	candidates := []rangeCandidate{
		{Tag: "v7.3.11"},
		{Tag: "v7.3.10"},
		{Tag: "v7.3.9"},
		{Tag: "v7.3.8"},
		{Tag: "v7.3.7"},
	}
	selected := SelectRange(candidates, "v7.3.8", "v7.3.11")
	// Order follows the candidates, which the store supplies newest-first, so the
	// merged log reads as a history without a second sort.
	want := []string{"v7.3.11", "v7.3.10", "v7.3.9"}
	if len(selected) != len(want) {
		t.Fatalf("selected %v, want %v", selected, want)
	}
	// The bounds are exclusive at the bottom and inclusive at the top: the running
	// version's own notes describe a version the operator already runs.
	for index, tag := range want {
		if selected[index] != tag {
			t.Fatalf("selected %v, want %v", selected, want)
		}
	}

	// Prereleases are excluded: a stable operator never received them, so their notes
	// would describe a build that was never offered.
	withPrerelease := append([]rangeCandidate{{Tag: "v7.3.9", Prerelease: true}}, candidates...)
	if got := SelectRange(withPrerelease, "v7.3.8", "v7.3.11"); len(got) != 3 {
		t.Fatalf("prereleases were included: %v", got)
	}

	// An unparsable running version yields no interval rather than a guess.
	if got := SelectRange(candidates, "v0.1.0-dev", "v7.3.11"); len(got) != 0 {
		t.Fatalf("an incomparable running version produced a range: %v", got)
	}
	// A running version at or ahead of the newest release has nothing to merge.
	if got := SelectRange(candidates, "v7.3.11", "v7.3.11"); len(got) != 0 {
		t.Fatalf("a current version produced a range: %v", got)
	}
	if got := SelectRange(candidates, "v8.0.0", "v7.3.11"); len(got) != 0 {
		t.Fatalf("an ahead version produced a range: %v", got)
	}
	// A release above the newest published one cannot be part of the interval.
	above := append([]rangeCandidate{{Tag: "v9.0.0"}}, candidates...)
	if got := SelectRange(above, "v7.3.8", "v7.3.11"); len(got) != 3 {
		t.Fatalf("a release beyond the newest was included: %v", got)
	}
}

func TestSortTagsDescendingUsesVersionOrderNotTextOrder(t *testing.T) {
	tags := []string{"v7.3.9", "v7.3.11", "v7.3.10", "v7.10.0", "named-release", "v7.3.2"}
	sorted := SortTagsDescending(tags)
	// A lexical sort would place v7.3.9 above v7.3.11; version order must not.
	if sorted[0] != "v7.10.0" {
		t.Fatalf("sorted[0] = %q, want v7.10.0", sorted[0])
	}
	if sorted[1] != "v7.3.11" || sorted[2] != "v7.3.10" || sorted[3] != "v7.3.9" {
		t.Fatalf("version order is wrong: %v", sorted)
	}
	// An unparsable tag sorts below comparable ones, which is the only ordering
	// available for a named release.
	if sorted[len(sorted)-1] != "named-release" {
		t.Fatalf("unparsable tag placed at %q, want last", sorted[len(sorted)-1])
	}
}

func TestValidateRepositoryRejectsAnythingButOwnerSlashName(t *testing.T) {
	for _, valid := range []string{"router-for-me/CLIProxyAPI", "WizisCool/oh-my-cpa", "a/b", "user.name/repo_name", "user/repo-2"} {
		if err := ValidateRepository(valid); err != nil {
			t.Errorf("ValidateRepository(%q) = %v, want nil", valid, err)
		}
	}
	// The value reaches a URL path, so traversal, extra segments and query strings
	// are refused rather than escaped.
	for _, invalid := range []string{"", "no-slash", "/leading", "trailing/", "a/b/c", "a/b?x=1", "a/../b", "a b/c", "a/#frag"} {
		if err := ValidateRepository(invalid); err == nil {
			t.Errorf("ValidateRepository(%q) = nil, want an error", invalid)
		}
	}
}

func TestReleasePublishedAtIsParsedOrAbsent(t *testing.T) {
	if got := (Release{PublishedAt: "2026-09-21T14:43:42Z"}).PublishedAtMS(); got == 0 {
		t.Fatal("a valid timestamp was not parsed")
	}
	// A missing or unparsable time reports zero rather than inventing one, so the page
	// can omit the date instead of printing a wrong one.
	for _, input := range []string{"", "not-a-time", "2026-09-21"} {
		if got := (Release{PublishedAt: input}).PublishedAtMS(); got != 0 {
			t.Errorf("PublishedAtMS(%q) = %d, want 0", input, got)
		}
	}
}
