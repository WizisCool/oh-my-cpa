# Publishing a release

The stable distribution is **`wiziscool/oh-my-cpa`** on Docker Hub, for
`linux/amd64` and `linux/arm64`. GitHub Releases in `WizisCool/oh-my-cpa` are the
console's version/update source and carry native executables and installation assets. A Git tag
alone is not a published release and is not discovered by update checks.

## Native assets

Every release publishes eight executables matching CPA's OS/architecture coverage:

| OS | Go architectures | Archive |
| --- | --- | --- |
| Darwin (macOS) | amd64, arm64 | tar.gz |
| Windows | amd64, arm64 | zip |
| Linux | amd64, arm64 | tar.gz |
| FreeBSD | amd64, arm64 | tar.gz |

Names follow `oh-my-cpa_VERSION_OS_ARCH.tar.gz` (Windows uses `.zip`), with the
numeric version without `v`. Each archive contains the executable (`oh-my-cpa.exe`
on Windows), MIT license, both READMEs, installation/operations/SQLite guides and `.env.example` from
`deploy/native.env.example`. No secrets or runtime data are included. `checksums.txt`
contains SHA-256 hashes for all eight archives and the three Compose/CPA installation
attachments; it does not hash itself.

The matrix is pinned in `scripts/native-release.mjs`, not downloaded during builds.
It was checked on October 6, 2026 against CPA's official release workflow at commit
`a2976eb8a303f11b4ea5177bce9f9ff752634dfc` and the v8.0.16 assets. CPA's current source
uses its [release workflow](https://github.com/router-for-me/CLIProxyAPI/blob/a2976eb8a303f11b4ea5177bce9f9ff752634dfc/.github/workflows/release.yaml) rather than GoReleaser. Its `aarch64` asset label
means Go `arm64`; its additional Linux plugin variants are not OMC targets. All OMC
builds use `CGO_ENABLED=0` with modernc SQLite and embed the IANA time-zone database
through `-tags timetzdata`. OS certificate roots are still required for HTTPS.
The Darwin and Windows executables are not code-signed or notarized.

Native package builders do not restore shared Actions caches for the pnpm store or Go modules/build outputs. Dependencies are installed from the frozen lockfile and binaries are compiled in the fresh release job, so another workflow's cached outputs cannot become publication inputs.

The existing release pipeline remains the publication authority (ADR 0066). To build
and inspect the same assets locally on Linux, install the repository's pinned Node,
pnpm and Go toolchains plus GNU tar, zip and unzip, then run:

```bash
pnpm install --frozen-lockfile
RELEASE_TAG=v$(node -p 'require("./package.json").version') node scripts/native-release.mjs
RELEASE_TAG=v$(node -p 'require("./package.json").version') node scripts/native-release-smoke.mjs
```

The builder validates both package versions, builds/syncs the SPA once before the
Go targets, verifies the actual Go build metadata, packages all targets into
`tmp/native-release`, and validates the complete checksum manifest. Archive member
timestamps use the source commit date; tar owners are normalized and zip strips
extra metadata. A clean output directory prevents stale assets from entering a retry.
The smoke check extracts the host-architecture Linux archive into a new directory
and checks SQLite, login, `/omc`, root and nested base paths, embedded JavaScript and
the running tag. Foreign targets are cross-compiled, not executed on Linux.

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
- Docker version aliases are `v0.1.4` and `0.1.4`; `latest` advances only for the
  numerically newest stable release. A backport never moves either Docker `latest`
  or GitHub's latest pointer backwards. Compose defaults to `latest` for both
  OMC and CPA. Operators can override
  `OMCPA_IMAGE` and `CPA_IMAGE` with a tested version or digest for controlled upgrades.
- Publish a new version for changed application content. Do not move a published tag
  or intentionally rebuild its identity with different source.

## Prepare and publish

Version-specific changes and upgrade notes are kept under `docs/releases/`; see
the [v0.1.4 release notes](releases/v0.1.4.md).

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
   git tag -a v0.1.4 -m "Oh My CPA v0.1.4"
   git push origin v0.1.4
   ```

4. Follow `.github/workflows/release.yml` in Actions:
   - **identity** validates tag/package identity and resolves the exact source commit.
   - **static**, **browser** and **probes** verify that commit in parallel: full
     static/secret gates, built SPA/browser/harness/demo gates and the full probe
     catalog in three balanced shards. Generated-state cleanliness remains mandatory.
   - **verify** is the final aggregate and accepts only success from every lane;
     failure, cancellation or skipped prerequisites prevent publication.
   - **publish** builds a native image and runs `scripts/docker-smoke.mjs` to verify
     the actual non-root/read-only package, SQLite permissions, canonical base paths,
     health, login and version endpoints. It then builds/pushes the amd64/arm64 image
     with provenance and SBOM to Docker Hub.
   - **native** runs after verification, builds the eight archives and checksum
     manifest, smoke-tests the extracted Linux package, asserts clean generated state
     and transfers the complete asset directory with pinned upload/download actions.
     It checks out the immutable verified revision and runs alongside **publish**,
     with no repository-write permission.
   - **release** runs only after both native packaging and a successful Docker push,
     revalidates downloaded assets against their checksums and expected matrix, then
     stages new GitHub releases as drafts with generated notes, the multi-platform
     digest and all assets. Only after every attachment succeeds does it recheck
     latest policy and publish the draft. Existing releases receive verified
     replacement assets through the same resumable path.
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
docker buildx imagetools inspect wiziscool/oh-my-cpa:v0.1.4
gh release view v0.1.4 --repo WizisCool/oh-my-cpa
```

Workflows use a serialized `queue: max` concurrency group: pending releases queue
instead of replacing each other, and running releases are not cancelled by newer tags.
GitHub limits this queue to 100 pending runs; beyond that, new runs are cancelled. A failed verification
cannot push or package; a failed image push or native package cannot publish a GitHub Release. If the final release
step fails after the image upload, retry the failed job, not an unrelated version.
New releases remain drafts if an attachment upload fails; update checks ignore them. Docker `latest` promotion follows
GitHub publication; if promotion fails, versioned pulls still work and only that job
needs retrying.
`workflow_dispatch` also accepts an existing verified tag for recovery. The identity
job resolves that tag; verification and publication consumers check out its resolved
revision, not the dispatch branch. The image revision names that verified commit.
Latest decisions are re-evaluated at publication/promotion, so retrying an old run
after a newer release cannot downgrade the latest pointers. Re-running the release-assets step verifies and replaces all native and installation attachments for the same
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

The browser and probe verification runners install and launch-probe Chromium after
package installation, using the same provisioner as CI. If a runner-only
workflow repair is needed before publication, merge the repair and dispatch from
`master` with the original tag. This changes orchestration, not the tagged image
source; application changes still require a new version.

## Publication identity and verification evidence

Every downstream checkout uses `needs.verify.outputs.revision`, not a second tag
checkout. `scripts/release-identity.mjs` resolves lightweight and annotated tags and
refuses a checkout or tag that differs from that verified commit. These checks run
at image, native, GitHub visibility and digest-promotion boundaries. A final external
tag movement cannot be made atomic with GitHub/Docker publication; restrict tag
movement at the repository level as well as retaining these fail-closed checks.

The release verification DAG mirrors CI instead of serializing the entire local
probe catalog inside one job. Local parity remains `pnpm verify:full`. Probe timings
and failure diagnostics survive failed runs. `static`, `browser` and aggregate
`probes` remain the merge-check names. Action revisions are immutable, checkout
credentials do not persist, and the native cache isolation policy is unchanged.

`pnpm verify:workflow` checks semantic publication/gate invariants with negative
mutation self-tests. CI also installs actionlint at the version pinned in
`scripts/lint-workflows.mjs` and runs `pnpm verify:workflow:lint`. That adapter only
normalizes the already-validated GitHub `concurrency.queue` extension for the pinned
actionlint schema; shell/expression structure is still checked. Shellcheck integration
is disabled explicitly rather than claiming shellcheck coverage.

Release bundle verification explicitly leaves the exact comparison base empty until
a previous release baseline is resolved. It reports growth as unavailable rather
than comparing a candidate to itself; loading boundaries and anomaly ceilings still
produce mandatory verdicts. An omitted local comparison base may use `origin/master`,
but the candidate itself is never a valid growth baseline.
