package capability

import (
	"context"
	"time"
)

type anchorKey struct{}

func WithAnchor(ctx context.Context, anchorMS int64) context.Context {
	return context.WithValue(ctx, anchorKey{}, anchorMS)
}
func AnchorMS(ctx context.Context) int64 {
	if anchor, ok := ctx.Value(anchorKey{}).(int64); ok && anchor > 0 {
		return anchor
	}
	return time.Now().UnixMilli()
}
