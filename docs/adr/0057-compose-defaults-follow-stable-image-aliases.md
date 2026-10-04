# ADR 0057: Compose defaults follow stable image aliases

- Status: Accepted
- Date: 2026-10-04
- Supersedes: ADR 0056's Compose image-default policy only.

## Context

The installation templates should install the current images without requiring a
new template for each release. Release identities, reproducible rollback and
operator control still require versioned images and immutable digests.

## Decision

Default OMC to `wiziscool/oh-my-cpa:latest` in both Compose topologies and CPA to
`eceasy/cli-proxy-api:latest` in the full-stack topology. Preserve `OMCPA_IMAGE` and
`CPA_IMAGE` overrides for version or digest pins. Downloaded Compose assets are
versioned independently of the default image aliases they reference.

The release workflow still uploads version aliases before publishing a GitHub
Release, then promotes only the newest stable OMC digest to `latest`. It does not
control CPA's upstream publication policy. Installation verification checks the
resolved image's version rather than assuming the template release is the runtime
release.

## Consequences

- A fresh pull obtains the current images; existing containers do not update
  themselves. Operators explicitly pull and recreate the selected service.
- Operators should pin both services when reproducibility is required and update
  CPA separately from OMC after checking its compatibility.
- Existing gateway state, master keys, collection ownership and private listener
  defaults remain unchanged.
