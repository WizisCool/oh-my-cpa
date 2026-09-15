package repository

import (
	"context"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

// rawCommandCodePayload is one CPA usage record as the queue published it, kept
// in the shape the gateway actually emits: an endpoint that is a request line, a
// client address, a forwarded chain, and both service tiers. Every value is
// deliberately synthetic - documentation-range addresses (RFC 5737) and made-up
// identifiers - so the test never carries a real capture's addresses or indexes.
const rawCommandCodePayload = `{"accounting_version":2,"alias":"fixture-alias",` +
	`"api_key":"sk-fixture-caller-key","auth_index":"fixture-auth-index","auth_type":"apikey",` +
	`"client_ip":"192.0.2.10","endpoint":"POST /v1/chat/completions",` +
	`"executor_type":"OpenAICompatExecutor","failed":false,"generate":true,"latency_ms":3614,` +
	`"model":"fixture-vendor/fixture-model","provider":"openai-compatible-fixture vendor",` +
	`"reasoning_effort":"high","request_id":"fixture-request-1","service_tier":"auto",` +
	`"response_service_tier":"default","x_forwarded_for":"198.51.100.7, 203.0.113.9",` +
	`"tokens":{"total_tokens":5}}`

// TestRequestMetadataSurvivesIngestAndPersistence walks a raw payload through
// the real production path - decode, then insert - and reads it back through
// both the list and the single-record projections.
//
// The metadata columns are masked at both boundaries, so this is the seam where
// a second masking pass that cannot accept its own output silently erased the
// client address. A unit test on the decoder or on the mapper alone cannot see
// that: each half looks correct on its own.
func TestRequestMetadataSurvivesIngestAndPersistence(t *testing.T) {
	repo := usageTestRepository(t)
	event, err := usage.DecodeEvent(rawCommandCodePayload, "default", time.Now())
	if err != nil {
		t.Fatalf("decode usage payload: %v", err)
	}
	if event.Endpoint != "POST /v1/chat/completions" {
		t.Fatalf("decoded endpoint = %q", event.Endpoint)
	}
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{event}); err != nil {
		t.Fatalf("insert usage event: %v", err)
	}

	page, err := repo.ListUsageEvents(context.Background(), UsageEventFilter{Limit: 5})
	if err != nil {
		t.Fatalf("list usage events: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("stored %d rows, want 1", len(page.Items))
	}
	row := page.Items[0]

	// The client address must survive as the masked network, not as NULL and
	// never as the raw address.
	if row.ClientIP == nil || *row.ClientIP != "192.0.2.0/24" {
		t.Fatalf("stored client IP = %v, want the masked network", derefString(row.ClientIP))
	}
	if row.XForwardedFor == nil || *row.XForwardedFor != "198.51.100.0/24" {
		t.Fatalf("stored forwarded-for = %v, want the first hop's network", derefString(row.XForwardedFor))
	}
	if row.Endpoint != "POST /v1/chat/completions" {
		t.Fatalf("stored endpoint = %q", row.Endpoint)
	}
	// Both tiers are distinct facts and neither may stand in for the other.
	if row.ServiceTier != "auto" {
		t.Fatalf("stored requested tier = %q, want auto", row.ServiceTier)
	}
	if row.ResponseServiceTier != "default" {
		t.Fatalf("stored response tier = %q, want default", row.ResponseServiceTier)
	}

	detail, err := repo.GetUsageEvent(context.Background(), row.ID)
	if err != nil {
		t.Fatalf("get usage event: %v", err)
	}
	if detail.Endpoint != "POST /v1/chat/completions" {
		t.Fatalf("detail endpoint = %q", detail.Endpoint)
	}
	if detail.ClientIP == nil || *detail.ClientIP != "192.0.2.0/24" {
		t.Fatalf("detail client IP = %v", derefString(detail.ClientIP))
	}
	if detail.XForwardedFor == nil || *detail.XForwardedFor != "198.51.100.0/24" {
		t.Fatalf("detail forwarded-for = %v", derefString(detail.XForwardedFor))
	}
	if detail.ResponseServiceTier != "default" || detail.ServiceTier != "auto" {
		t.Fatalf("detail tiers = %q/%q", detail.ServiceTier, detail.ResponseServiceTier)
	}
}

// TestCommitUsageDecodedKeepsRequestMetadata covers the inbox-backed ingest path,
// which shares the insert projection but has its own transaction and sanitizing
// boundary.
func TestCommitUsageDecodedKeepsRequestMetadata(t *testing.T) {
	repo := usageTestRepository(t)
	written, err := repo.AppendUsageInbox(context.Background(), "default", "http_pull",
		[]string{rawCommandCodePayload}, time.Now())
	if err != nil {
		t.Fatalf("append usage inbox: %v", err)
	}
	if written != 1 {
		t.Fatalf("appended %d inbox rows, want 1", written)
	}
	pending, err := repo.ClaimUsageInboxBatch(context.Background(), 10)
	if err != nil {
		t.Fatalf("claim usage inbox batch: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("claimed %d inbox rows, want 1", len(pending))
	}
	// Decode from what the inbox actually stored, not from the literal. Storage
	// projects the payload through RedactPayload, so decoding the original string
	// would skip the transformation the real collector always performs.
	event, err := usage.DecodeEventWithFingerprinter(pending[0].RawMessage, "default",
		time.UnixMilli(pending[0].PoppedAtMS), nil)
	if err != nil {
		t.Fatalf("decode stored payload: %v", err)
	}
	committed, err := repo.CommitUsageDecoded(context.Background(), []UsageDecoded{{InboxID: pending[0].ID, Event: event}})
	if err != nil {
		t.Fatalf("commit decoded usage: %v", err)
	}
	if committed != 1 {
		t.Fatalf("committed %d events, want 1", committed)
	}

	page, err := repo.ListUsageEvents(context.Background(), UsageEventFilter{Limit: 5})
	if err != nil {
		t.Fatalf("list usage events: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("stored %d rows, want 1", len(page.Items))
	}
	row := page.Items[0]
	if row.ClientIP == nil || *row.ClientIP != "192.0.2.0/24" {
		t.Fatalf("stored client IP = %v, want the masked network", derefString(row.ClientIP))
	}
	if row.XForwardedFor == nil || *row.XForwardedFor != "198.51.100.0/24" {
		t.Fatalf("stored forwarded-for = %v", derefString(row.XForwardedFor))
	}
	if row.Endpoint != "POST /v1/chat/completions" {
		t.Fatalf("stored endpoint = %q", row.Endpoint)
	}
}

// TestMissingRequestMetadataStaysNull keeps absence honest: a payload without
// the optional fields must store nothing rather than a placeholder, which is
// what lets the console say "not captured" instead of showing a fake address.
func TestMissingRequestMetadataStaysNull(t *testing.T) {
	repo := usageTestRepository(t)
	raw := `{"request_id":"no-metadata","provider":"openai","model":"m","tokens":{"total_tokens":1}}`
	event, err := usage.DecodeEvent(raw, "default", time.Now())
	if err != nil {
		t.Fatalf("decode usage payload: %v", err)
	}
	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{event}); err != nil {
		t.Fatalf("insert usage event: %v", err)
	}
	page, err := repo.ListUsageEvents(context.Background(), UsageEventFilter{Limit: 5})
	if err != nil {
		t.Fatalf("list usage events: %v", err)
	}
	row := page.Items[0]
	if row.ClientIP != nil || row.XForwardedFor != nil || row.Endpoint != "" {
		t.Fatalf("absent metadata was invented: ip=%v xff=%v endpoint=%q",
			derefString(row.ClientIP), derefString(row.XForwardedFor), row.Endpoint)
	}
	// The row still has to be readable, which is the history-compatibility
	// guarantee the console relies on.
	if _, err := repo.GetUsageEvent(context.Background(), row.ID); err != nil {
		t.Fatalf("read record without metadata: %v", err)
	}
}

func derefString(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func TestStreamFlagSurvivesPersistence(t *testing.T) {
	repo := usageTestRepository(t)
	rawStreaming := `{"request_id":"req-streaming","stream":true,"provider":"openai","model":"m","tokens":{"total_tokens":1}}`
	rawNonStreaming := `{"request_id":"req-non-streaming","stream":false,"provider":"openai","model":"m","tokens":{"total_tokens":1}}`
	rawOmitted := `{"request_id":"req-omitted","provider":"openai","model":"m","tokens":{"total_tokens":1}}`

	evStream, err := usage.DecodeEvent(rawStreaming, "default", time.Now())
	if err != nil {
		t.Fatalf("decode streaming: %v", err)
	}
	evNonStream, err := usage.DecodeEvent(rawNonStreaming, "default", time.Now().Add(time.Millisecond))
	if err != nil {
		t.Fatalf("decode non-streaming: %v", err)
	}
	evOmitted, err := usage.DecodeEvent(rawOmitted, "default", time.Now().Add(2*time.Millisecond))
	if err != nil {
		t.Fatalf("decode omitted: %v", err)
	}

	if _, err := repo.InsertUsageEvents(context.Background(), []usage.Event{evStream, evNonStream, evOmitted}); err != nil {
		t.Fatalf("insert usage events: %v", err)
	}

	page, err := repo.ListUsageEvents(context.Background(), UsageEventFilter{Limit: 10})
	if err != nil {
		t.Fatalf("list usage events: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(page.Items))
	}

	lookup := make(map[string]*bool)
	for _, item := range page.Items {
		lookup[item.RequestID] = item.Stream
		// Also verify GetUsageEvent reads it identically.
		got, errGet := repo.GetUsageEvent(context.Background(), item.ID)
		if errGet != nil {
			t.Fatalf("get usage event %d: %v", item.ID, errGet)
		}
		if (got.Stream == nil) != (item.Stream == nil) || (got.Stream != nil && *got.Stream != *item.Stream) {
			t.Fatalf("GetUsageEvent stream mismatch for %s: got %v, list had %v", item.RequestID, got.Stream, item.Stream)
		}
	}

	if s := lookup["req-streaming"]; s == nil || *s != true {
		t.Fatalf("req-streaming: want stream=true, got %v", s)
	}
	if s := lookup["req-non-streaming"]; s == nil || *s != false {
		t.Fatalf("req-non-streaming: want stream=false, got %v", s)
	}
	if s := lookup["req-omitted"]; s != nil {
		t.Fatalf("req-omitted: want stream=nil, got %v", *s)
	}
}
