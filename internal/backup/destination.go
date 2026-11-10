package backup

import (
	"context"
	"io"

	"github.com/rclone/rclone/fs"
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

// rclone builds some HTTP clients lazily from the operation context, so its
// selected route must accompany each operation as well as destination creation.
type proxyDestination struct {
	Destination
	proxyURL string
}

func proxyContext(ctx context.Context, proxyURL string) context.Context {
	ctx, config := fs.AddConfig(ctx)
	config.HTTPProxy = proxyURL
	return ctx
}

func (d proxyDestination) Probe(ctx context.Context) error {
	return d.Destination.Probe(proxyContext(ctx, d.proxyURL))
}
func (d proxyDestination) Put(ctx context.Context, ref ObjectRef, source ArtifactSource) (Receipt, error) {
	return d.Destination.Put(proxyContext(ctx, d.proxyURL), ref, source)
}
func (d proxyDestination) Open(ctx context.Context, ref ObjectRef) (io.ReadCloser, error) {
	return d.Destination.Open(proxyContext(ctx, d.proxyURL), ref)
}
func (d proxyDestination) List(ctx context.Context, cursor string) (ObjectPage, error) {
	return d.Destination.List(proxyContext(ctx, d.proxyURL), cursor)
}
func (d proxyDestination) Delete(ctx context.Context, ref ObjectRef) error {
	return d.Destination.Delete(proxyContext(ctx, d.proxyURL), ref)
}
