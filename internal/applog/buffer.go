// Package applog keeps a bounded, redacted copy of Oh My CPA's own service log so
// the console can read it without shell access to the container.
//
// The process still writes every record to stderr, which stays the durable log a
// deployment ships elsewhere; this buffer only answers "what did the service just
// say", so it is sized for minutes of activity, lives in memory, and resets on
// restart by design.
package applog

import (
	"sync"
	"time"
)

// DefaultCapacity is how many records the console can scroll back through. It is
// a memory bound, not a retention promise: at roughly one kilobyte per record the
// buffer stays near two megabytes however noisy the process becomes.
const DefaultCapacity = 2000

// Attr is one structured field of a record, rendered as text.
type Attr struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Record is one captured log entry. Seq increases by one per record for the life of
// the process, so a reader can resume from the last one it saw and detect a gap.
type Record struct {
	Seq        uint64 `json:"seq"`
	LoggedAtMS int64  `json:"logged_at_ms"`
	Level      string `json:"level"`
	Message    string `json:"message"`
	Attrs      []Attr `json:"attrs,omitempty"`
}

// Page is one read of the buffer.
type Page struct {
	Records []Record
	// LatestSeq is the newest sequence number written so far; a reader passes it
	// back as `after` to receive only what follows.
	LatestSeq uint64
	// OldestSeq is the oldest record still held; zero when the buffer is empty.
	OldestSeq uint64
	// Gap reports that records after the reader's position were evicted or
	// skipped by the limit before this read could return them.
	Gap bool
}

// Buffer is a fixed-capacity ring of records, safe for concurrent use.
type Buffer struct {
	mu        sync.Mutex
	records   []Record
	start     int
	count     int
	seq       uint64
	startedAt time.Time
}

// NewBuffer returns an empty buffer; a non-positive capacity uses DefaultCapacity.
func NewBuffer(capacity int) *Buffer {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	return &Buffer{records: make([]Record, capacity), startedAt: time.Now()}
}

// Capacity is the most records the buffer holds at once.
func (b *Buffer) Capacity() int { return len(b.records) }

// StartedAt is when capture began, which bounds how far back any read can reach.
func (b *Buffer) StartedAt() time.Time { return b.startedAt }

// Append stores a record, evicting the oldest once full, and returns its sequence.
func (b *Buffer) Append(record Record) uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	record.Seq = b.seq
	capacity := len(b.records)
	if b.count < capacity {
		b.records[(b.start+b.count)%capacity] = record
		b.count++
	} else {
		b.records[b.start] = record
		b.start = (b.start + 1) % capacity
	}
	return record.Seq
}

// Since returns the records newer than `after`, oldest first.
//
// When more than `limit` records qualify, the newest `limit` win and Gap is set: a
// tail exists to show what is happening now, so a reader that fell behind jumps to
// the present and is told it skipped, instead of replaying a backlog it would then
// have to scroll past.
func (b *Buffer) Since(after uint64, limit int) Page {
	b.mu.Lock()
	defer b.mu.Unlock()
	page := Page{LatestSeq: b.seq}
	if b.count == 0 {
		return page
	}
	capacity := len(b.records)
	oldest := b.records[b.start].Seq
	page.OldestSeq = oldest
	first := after + 1
	if first < oldest {
		// Only a reader that had a position can have missed anything.
		page.Gap = after > 0
		first = oldest
	}
	if first > b.seq {
		return page
	}
	available := int(b.seq - first + 1)
	if limit <= 0 || limit > capacity {
		limit = capacity
	}
	if available > limit {
		page.Gap = true
		first = b.seq - uint64(limit) + 1
		available = limit
	}
	offset := int(first - oldest)
	page.Records = make([]Record, available)
	for i := 0; i < available; i++ {
		page.Records[i] = b.records[(b.start+offset+i)%capacity]
	}
	return page
}
