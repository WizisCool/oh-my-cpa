# Publishing a release

The stable distribution is **`wiziscool/oh-my-cpa`** on Docker Hub, for
`linux/amd64` and `linux/arm64`. GitHub Releases in `WizisCool/oh-my-cpa` are the
console's version/update source and carry standalone installation assets. A Git tag
alone is not a published release and is not discovered by update checks.

## One-time configuration

Create a Docker Hub access token for `wiziscool` with repository read/write permission,
and put it in the GitHub repository's Actions secret **`DOCKERHUB_TOKEN`**. Never
commit or paste the value into an issue, run log or chat:

```bash
gh secret set DOCKERHUB_TOKEN --repo WizisCool/oh-my-cpa
```

The workflow uses the repository-scoped `GITHUB_TOKEN` to create the release; only its
release job has `contents: write`. No GitHub personal token is required. Keep
Docker Hub repository visibility public so an installation can pull without logging in.
Enable Actions in the repository. Restrict creation/movement of release tags to trusted
maintainers with repository rules; a version tag is a publishing authority.

## Version contract

- Stable tags are **`vMAJOR.MINOR.PATCH`**, without leading zeros or suffixes. The tag
  must match both root `package.json` and `web/package.json` versions.
- `scripts/release-plan.mjs` validates the identity before building. Pre-release,
  development and malformed tags are refused; the update service intentionally does not
  claim stable currency for those versions (ADR 0019).
- A release embeds its exact tag into `internal/config.BuildVersion` with the Go
  linker. The config, health endpoint, SPA runtime config, System Information and
  outbound default User-Agent all use that value. `OMCPA_VERSION` remains an operator
  override; the Compose files do not override the embedded version.
- Docker version aliases are `v0.1.2` and `0.1.2`; `latest` advances only for the
  numerically newest stable release. A backport never moves either Docker `latest`
  or GitHub's latest pointer backwards. Compose defaults to `latest` for both
  OMC and CPA. Operators can override
  `OMCPA_IMAGE` and `CPA_IMAGE` with a tested version or digest for controlled upgrades.
- Publish a new version for changed application content. Do not move a published tag
  or intentionally rebuild its identity with different source.

## Prepare and publish

Version-specific changes and upgrade notes are kept under `docs/releases/`; see
the [v0.1.2 release notes](releases/v0.1.2.md).

1. Change both package versions together and document user-visible changes. The
   install guides download from `releases/latest/download/` and Compose defaults to
   the `latest` image, so neither needs a version bump. Keep lockfile metadata
   consistent if a package update requires it.
2. Run `pnpm test:fast`, `pnpm verify` and `pnpm check:ui`; run `pnpm verify:full`
   for build/workflow changes. Review secrets and changes, then merge through the
   normal protected pull-request checks.
3. From a clean checkout of the verified merged commit, create and push the tag:

   ```bash
   git switch master
   git pull --ff-only
   test -z "$(git status --porcelain)"
   git tag -a v0.1.2 -m "Oh My CPA v0.1.2"
   git push origin v0.1.2
   ```

4. Follow `.github/workflows/release.yml` in Actions:
   - **verify** validates tag/package identity and runs `pnpm verify:full`, including
     full static, built SPA/browser, probe and demo gates plus clean generated state.
   - **publish** builds a native image and runs `scripts/docker-smoke.mjs` to verify
     the actual non-root/read-only package, SQLite permissions, canonical base paths,
     health, login and version endpoints. It then builds/pushes the amd64/arm64 image
     with provenance and SBOM to Docker Hub.
   - **release** runs only after a successful push, publishes generated release notes
     with the multi-platform digest, and attaches `deploy/compose.full.yml`,
     `deploy/compose.omc.yml` and `deploy/cpa.config.example.yaml`.
   - **promote** rechecks the published stable index and moves Docker `latest` to the
     uploaded immutable digest only if no newer stable release exists.
5. Verify the public manifest and assets, pull the image on the desired platform,
   and check a new install's running version and System Information update check.

The Dockerfile builds Node and Go on the builder's native architecture and
cross-compiles the Go target. Architecture-independent certificate/timezone/account
files are prepared natively, while the final Alpine base supplies target-native shell
utilities. No privileged emulator registration is needed. Both targets must build;
the native packaged-image smoke complements the product's built-browser acceptance.

## Verification and recovery

```bash
gh run list --workflow release.yml --repo WizisCool/oh-my-cpa
docker buildx imagetools inspect wiziscool/oh-my-cpa:v0.1.2
gh release view v0.1.2 --repo WizisCool/oh-my-cpa
```

Workflows use a serialized `queue: max` concurrency group: pending releases queue
instead of replacing each other, and running releases are not cancelled by newer tags.
GitHub limits this queue to 100 pending runs; beyond that, new runs are cancelled. A failed verification
cannot push; a failed image push cannot publish a GitHub Release. If the final release
step fails after the image upload, retry the failed job, not an unrelated version. Docker `latest` promotion follows
GitHub publication; if promotion fails, versioned pulls still work and only that job
needs retrying.
`workflow_dispatch` also accepts an existing verified tag for recovery; checkout uses
that tag and the image revision names its actual commit, not the dispatch branch.
Latest decisions are re-evaluated at publication/promotion, so retrying an old run
after a newer release cannot downgrade the latest pointers. Re-running the release-assets step replaces the installation attachments for the same
source without creating a duplicate release. Do not delete/recreate a version tag to
work around a failed gate.

## Update checks after publishing

The console reads stable release metadata from `api.github.com`, not Docker Hub tags.
It orders comparable versions numerically, ignores drafts and pre-releases, distinguishes
newer/equal/ahead/indeterminate outcomes, and keeps its last successful index on a failed
request. Its per-product 15-minute attempt floor, six-hour sweep, offline switches,
ETag/body lifetime and source restrictions are unchanged. An install may show cached
results until the floor elapses; do not bypass it to make an immediate post-release
check appear fresh. See `docs/operations.md` and ADR 0019.

Release actions use immutable upstream commit revisions, and checkout credentials
are not persisted. GitHub release commands receive their job-scoped token explicitly.

The verification runner installs and launch-probes Chromium after package installation
and before `pnpm verify:full`, using the same provisioner as CI. If a runner-only
workflow repair is needed before publication, merge the repair and dispatch from
`master` with the original tag. This changes orchestration, not the tagged image
source; application changes still require a new version.
