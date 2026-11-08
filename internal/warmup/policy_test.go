package warmup

import (
	"slices"
	"testing"
	"time"
)

func mustTime(t *testing.T, iso string) time.Time {
	t.Helper()
	parsed, ok := ParseISO(iso)
	if !ok {
		t.Fatalf("invalid ISO time %q", iso)
	}
	return parsed
}

func TestPickAutoModel(t *testing.T) {
	models := []string{
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-haiku-4-5-20251001",
		"claude-3-5-haiku-20241022",
		"gpt-5",
		"gpt-5-mini",
		"gpt-5.1-codex-mini",
		"gemini-2.0-flash",
		"gemini-2.5-flash",
	}
	if got := PickAutoModel(models, nil); got != "gemini-2.5-flash" {
		t.Fatalf("PickAutoModel = %q, want gemini-2.5-flash", got)
	}

	codexOnly := []string{"gpt-5", "gpt-5-codex", "gpt-5-mini", "gpt-5.1-codex-mini"}
	if got := PickAutoModel(codexOnly, nil); got != "gpt-5.1-codex-mini" {
		t.Fatalf("PickAutoModel(codex) = %q, want gpt-5.1-codex-mini", got)
	}

	claudeOnly := []string{"claude-opus-4-6", "claude-sonnet-4-6", "claude-3-5-haiku-20241022", "claude-haiku-4-5-20251001"}
	if got := PickAutoModel(claudeOnly, nil); got != "claude-haiku-4-5-20251001" {
		t.Fatalf("PickAutoModel(claude) = %q, want claude-haiku-4-5-20251001", got)
	}

	// "minimax" must not match "mini" because of word boundaries.
	noSpec := []string{"minimax-m1", "deepseek-r1", "qwen-max-2"}
	sorted := SortModelsForAuto(noSpec, nil)
	if !slices.Equal(sorted, []string{"qwen-max-2", "minimax-m1", "deepseek-r1"}) {
		t.Fatalf("SortModelsForAuto(noSpec, nil) = %v", sorted)
	}

	// An OAuth alias is an operator's name for another model: it ranks as the model it reaches,
	// never by its own letters, and the alias is what gets sent.
	if got := PickAutoModel([]string{"gpt-5.2", "zeta"}, map[string]string{"zeta": "gpt-5.1"}); got != "gpt-5.2" {
		t.Fatalf("PickAutoModel(alias of an older model) = %q, want gpt-5.2", got)
	}
	if got := PickAutoModel([]string{"gpt-5.4", "alpha"}, map[string]string{"alpha": "gpt-5.4-mini"}); got != "alpha" {
		t.Fatalf("PickAutoModel(alias of a mini model) = %q, want alpha", got)
	}

	// A listed name that reaches no model at all ranks last instead of winning the descending
	// tie-break on its letters, and it remains the answer when nothing else is listed.
	if got := PickAutoModel([]string{"gpt-5.2", "gpt-5.2-codex", "retain"}, nil); got != "gpt-5.2-codex" {
		t.Fatalf("PickAutoModel(unversioned name) = %q, want gpt-5.2-codex", got)
	}
	if got := PickAutoModel([]string{"retain"}, nil); got != "retain" {
		t.Fatalf("PickAutoModel(only an unversioned name) = %q, want retain", got)
	}
	// The version check reads the ranked name, so an alias of a real model keeps that model's rank.
	if got := PickAutoModel([]string{"gpt-5.2", "retain"}, map[string]string{"retain": "gpt-5.4"}); got != "retain" {
		t.Fatalf("PickAutoModel(alias of a newer model) = %q, want retain", got)
	}

	if got := PickAutoModel(nil, nil); got != "" {
		t.Fatalf("PickAutoModel(nil) = %q, want empty", got)
	}
}

func TestFilterWarmupModels(t *testing.T) {
	models := []string{
		"gpt-5.4",
		"gpt-image-1",
		"gemini-2.5-flash-image",
		"dall-e-3",
		"imagen-4.0-generate-001",
		"flux-1-dev",
		"claude-haiku-4-5",
		"deep-research-preview-04-2026",
		"openai/gpt-image-2",
	}
	want := []string{"gpt-5.4", "claude-haiku-4-5", "deep-research-preview-04-2026"}
	if got := FilterWarmupModels(models, nil); !slices.Equal(got, want) {
		t.Fatalf("FilterWarmupModels = %v, want %v", got, want)
	}
	if got := FilterWarmupModels([]string{"gpt-image-1"}, nil); len(got) != 0 {
		t.Fatalf("FilterWarmupModels(image only) = %v, want empty", got)
	}
	// A call point is judged by the model it reaches, so a name that hides an image model is
	// dropped as well.
	if got := FilterWarmupModels([]string{"draw", "gpt-5.4"}, map[string]string{"draw": "openai/gpt-image-2"}); !slices.Equal(got, []string{"gpt-5.4"}) {
		t.Fatalf("FilterWarmupModels(alias of an image model) = %v, want [gpt-5.4]", got)
	}
}

func TestNextDailyAndDST(t *testing.T) {
	after := mustTime(t, "2026-04-12T00:30:00.000Z") // 08:30 Asia/Shanghai
	next, ok := NextDaily(after, "09:00", "Asia/Shanghai")
	if !ok || FormatISO(next) != "2026-04-12T01:00:00.000Z" {
		t.Fatalf("same day = %v %v", FormatISO(next), ok)
	}

	afterPassed := mustTime(t, "2026-04-12T01:00:00.000Z") // exact 09:00 Asia/Shanghai
	next, ok = NextDaily(afterPassed, "09:00", "Asia/Shanghai")
	if !ok || FormatISO(next) != "2026-04-13T01:00:00.000Z" {
		t.Fatalf("next day = %v %v", FormatISO(next), ok)
	}

	// 2026-03-08 is US spring-forward day in America/New_York (02:00 jumps to 03:00).
	dstAfter := mustTime(t, "2026-03-08T06:00:00.000Z")
	next, ok = NextDaily(dstAfter, "02:30", "America/New_York")
	if !ok || !next.After(dstAfter) {
		t.Fatalf("DST gap = %v %v", FormatISO(next), ok)
	}
}

func TestNextEveryAndLastDue(t *testing.T) {
	anchor := "2026-04-12T00:00:00.000Z"
	next, ok := NextEvery(mustTime(t, "2026-04-12T05:00:00.000Z"), 5, anchor)
	if !ok || FormatISO(next) != "2026-04-12T10:00:00.000Z" {
		t.Fatalf("NextEvery exact boundary = %v %v", FormatISO(next), ok)
	}

	next, ok = NextEvery(mustTime(t, "2026-04-11T20:00:00.000Z"), 5, anchor)
	if !ok || FormatISO(next) != anchor {
		t.Fatalf("NextEvery before anchor = %v %v", FormatISO(next), ok)
	}

	due, ok := LastDue(mustTime(t, "2026-04-12T12:30:00.000Z"), Trigger{Kind: "every", Hours: 5, Anchor: anchor})
	if !ok || FormatISO(due) != "2026-04-12T10:00:00.000Z" {
		t.Fatalf("LastDue(every) = %v %v", FormatISO(due), ok)
	}

	due, ok = LastDue(mustTime(t, "2026-04-12T03:00:00.000Z"), Trigger{Kind: "daily", Time: "09:00", TimeZone: "Asia/Shanghai"})
	if !ok || FormatISO(due) != "2026-04-12T01:00:00.000Z" {
		t.Fatalf("LastDue(daily) = %v %v", FormatISO(due), ok)
	}
}

func TestWindowDueAndGuards(t *testing.T) {
	zero := 0.0
	used := 42.0
	active := &QuotaWindow{ID: "five_hour", Label: "5h", UsedPercent: &used, ResetsAt: "2026-04-12T10:00:00.000Z"}
	due := WindowDue(active, "2026-04-12T08:00:00.000Z")
	if due == nil || due.Idle || due.At != "2026-04-12T10:00:30.000Z" || due.ResetKey != "2026-04-12T10:00:00.000Z" {
		t.Fatalf("active WindowDue = %+v", due)
	}

	idle := &QuotaWindow{ID: "five_hour", Label: "5h", UsedPercent: &zero}
	due = WindowDue(idle, "2026-04-12T08:23:45.000Z")
	if due == nil || !due.Idle || due.At != "2026-04-12T08:23:45.000Z" || due.ResetKey != "idle:2026-04-12T08:00:00.000Z" {
		t.Fatalf("idle WindowDue = %+v", due)
	}

	expired := &QuotaWindow{ID: "five_hour", Label: "5h", UsedPercent: &used, ResetsAt: "2026-04-12T08:00:00.000Z"}
	due = WindowDue(expired, "2026-04-12T08:05:00.000Z")
	if due == nil || !due.Idle || due.ResetKey != "idle:2026-04-12T08:00:00.000Z" {
		t.Fatalf("expired WindowDue = %+v", due)
	}

	// CurrentWindowDue guards against stale idle readings within 60s of LastSent and against transient missing ResetsAt before LastReset.
	task := Task{ID: "t1", Enabled: true, Trigger: Trigger{Kind: "window", Window: "five_hour"}}
	account := &CatalogAccount{
		AuthIndex:  "acc-1",
		SnapshotAt: "2026-04-12T08:00:30.000Z",
		Windows:    []QuotaWindow{*idle},
	}
	if got := CurrentWindowDue(task, account, TaskMarks{LastSent: "2026-04-12T08:00:00.000Z"}, mustTime(t, "2026-04-12T08:00:35.000Z")); got != nil {
		t.Fatalf("expected stale idle reading within 60s of LastSent to be ignored, got %+v", got)
	}
	if got := CurrentWindowDue(task, account, TaskMarks{LastReset: "2026-04-12T09:00:00.000Z"}, mustTime(t, "2026-04-12T08:00:35.000Z")); got != nil {
		t.Fatalf("expected future LastReset to suppress transient missing ResetsAt, got %+v", got)
	}
	if got := CurrentWindowDue(task, account, TaskMarks{LastReset: "2026-04-12T07:00:00.000Z"}, mustTime(t, "2026-04-12T08:00:35.000Z")); got == nil || !got.Idle {
		t.Fatalf("expected passed LastReset to allow idle trigger, got %+v", got)
	}
}

func TestValidateTask(t *testing.T) {
	valid := TaskInput{
		Provider:  "claude",
		AuthIndex: "auth-1",
		Trigger:   Trigger{Kind: "window", Window: "five_hour"},
	}
	if err := ValidateTask(valid); err != nil {
		t.Fatalf("ValidateTask(valid) = %v", err)
	}
	if err := ValidateTask(TaskInput{Provider: "", AuthIndex: "auth-1", Trigger: Trigger{Kind: "window", Window: "five_hour"}}); err == nil {
		t.Fatal("expected invalid provider error")
	}
	if err := ValidateTask(TaskInput{Provider: "claude", AuthIndex: "auth-1", Trigger: Trigger{Kind: "daily", Time: "25:00", TimeZone: "UTC"}}); err == nil {
		t.Fatal("expected invalid clock error")
	}
	if err := ValidateTask(TaskInput{Provider: "codex", AuthIndex: "auth-1", Trigger: Trigger{Kind: "every", Hours: 0, Anchor: "2026-04-12T00:00:00Z"}}); err == nil {
		t.Fatal("expected invalid interval hours error")
	}
}
