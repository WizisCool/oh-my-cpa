package updater

import (
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/release"
)

// Reference is a parsed image reference.
type Reference struct {
	Repository string
	Tag        string
	Digest     string
}

// ParseReference splits "repository[:tag][@digest]". A colon inside the registry host
// ("registry:5000/name") is a port, not a tag, so only a colon after the last slash
// separates the tag.
func ParseReference(raw string) Reference {
	reference := Reference{}
	name, digest, _ := strings.Cut(strings.TrimSpace(raw), "@")
	reference.Digest = digest
	lastSlash := strings.LastIndex(name, "/")
	if colon := strings.LastIndex(name, ":"); colon > lastSlash {
		reference.Tag = name[colon+1:]
		name = name[:colon]
	}
	reference.Repository = name
	return reference
}

// EffectiveTag is the tag the daemon resolves: an omitted tag means "latest".
func (r Reference) EffectiveTag() string {
	if r.Tag == "" {
		return "latest"
	}
	return r.Tag
}

// IsPinned reports whether the operator fixed the image to one release, by digest or
// by a version tag.
//
// A pinned container is never replaced. The pin lives in the operator's Compose file
// or `.env`, which the updater cannot edit, so the next `docker compose up` would put
// the pinned image back: a silent downgrade under a database whose migrations only go
// forward.
func (r Reference) IsPinned() bool {
	if r.Digest != "" {
		return true
	}
	if r.Tag == "" {
		return false
	}
	_, err := release.ParseVersion(r.Tag)
	return err == nil
}

// CanonicalRepository removes the spellings of Docker Hub that name the same
// repository, so "docker.io/wiziscool/oh-my-cpa" and "wiziscool/oh-my-cpa" compare
// equal.
func CanonicalRepository(repository string) string {
	canonical := strings.ToLower(strings.TrimSpace(repository))
	for _, prefix := range []string{"index.docker.io/", "docker.io/", "registry-1.docker.io/"} {
		canonical = strings.TrimPrefix(canonical, prefix)
	}
	return strings.TrimPrefix(canonical, "library/")
}
