package backup

import (
	"context"
	"io"
)

// ArtifactSource permits repeatable and resumable delivery without exposing a
// database handle or requiring an entire backup to fit in memory.
type ArtifactSource interface {
	Size() int64
	SHA256() string
	Open(ctx context.Context, offset int64) (io.ReadCloser, error)
}

type ObjectRef struct {
	Key       string
	SizeBytes int64
}
type Receipt struct {
	Object       ObjectRef
	Size         int64
	Checksum     string
	Verification string
}
type ObjectPage struct {
	Items      []ObjectRef
	NextCursor string
}
type Capabilities struct {
	CanResume            bool
	HasRemoteChecksum    bool
	CanCreateExclusively bool
}

// Destination moves completed encrypted artifacts only. It is not a general URL
// proxy; implementations are constructed from operator-approved destinations.
type Destination interface {
	Probe(context.Context) error
	Put(context.Context, ObjectRef, ArtifactSource) (Receipt, error)
	Open(context.Context, ObjectRef) (io.ReadCloser, error)
	List(context.Context, string) (ObjectPage, error)
	Delete(context.Context, ObjectRef) error
	Capabilities() Capabilities
	Close() error
}
