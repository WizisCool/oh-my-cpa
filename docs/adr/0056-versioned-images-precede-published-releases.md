# ADR 0056: Versioned images precede published releases

- Status: Accepted
- Date: 2026-10-04
- Extends: ADR 0019 with distribution and release automation; its comparison, cache,
  source restriction and release-note policies remain unchanged.

## Context

OMC's update source is GitHub Releases, but source-built Docker deployments did not
embed a release identity. A release advertised before its image is available would
invite an upgrade that cannot be installed. Existing gateways and other management
panels also make a mandatory all-in-one proxy topology unsafe as an installation default.

## Decision

Distribute stable amd64/arm64 builds from `wiziscool/oh-my-cpa` on Docker Hub. Embed
the exact validated `vMAJOR.MINOR.PATCH` tag in the Go binary, retaining development
identity for untagged builds and explicit operator override precedence.

A trusted tag starts verification, then native packaged-image acceptance and
multi-platform publishing, then creation of a GitHub Release carrying installation
assets and the image digest. Image upload is a prerequisite for release visibility.
Serialize publishing and order versions numerically so a backport cannot regress
Docker or GitHub's latest pointer. Changed content requires a new release identity;
published tags are not moved to describe different source.

Compose consumes a pinned image, publishes direct loopback listeners, and offers
separate new-stack and OMC-only topologies. Existing gateways, panels, network rules,
keys and collection ownership are preserved by default. HTTPS ingress is operator-owned.
The bundled Caddy templates and entrypoint are retired; upgrades from that topology
must arrange access with existing infrastructure rather than assuming Compose provides TLS.

## Consequences

- An advertised update corresponds to an uploaded image and a comparable running
  version. A standalone tag without a GitHub Release remains invisible to the checker.
- Installing from an image no longer requires a frontend/Go toolchain or source clone.
- Maintainers must protect version-tag creation and configure a Docker Hub push token
  in Actions; only the release-publication job needs GitHub write access.
- The Docker registry and GitHub are separate systems: an image can upload before
  release creation fails. Recovery retries publication against the same source rather
  than rewriting the tag; immutable digests let operators identify the uploaded build.
- Direct loopback access is simple and safe locally, but public HTTPS must be provided
  by the operator. A fresh minimal CPA configuration must never replace existing state.
