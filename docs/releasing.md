# Releasing Oh My CPA

Official container images are published to `wiziscool/oh-my-cpa` on Docker Hub for
amd64 and arm64. GitHub Releases carry native packages, installation assets and the
signed manifest used by the updater. A Git tag alone is not a published release.

## Publication invariants

- Stable tags are `vMAJOR.MINOR.PATCH`, without suffixes or leading zeros, and match
  both package manifests. Use a new version for changed application content; never
  move a published tag or rebuild it from different application source.
- The tag resolves to one immutable verified commit. Image, native-package, release
  and promotion steps must check out that revision, not a mutable branch or a newly
  resolved tag. Restrict tag creation/movement to maintainers as an additional boundary.
- The build embeds its exact tag in `internal/config.BuildVersion`. An operator's
  `OMCPA_VERSION` override changes presentation, not the installed build's identity.
- Version tags have both `vX.Y.Z` and `X.Y.Z` Docker aliases. Docker `latest` and
  GitHub's latest pointer advance only to the numerically newest stable release;
  a backport or retry cannot move them backwards.
- Verification, secret scans, generated-state cleanliness and packaged-image smoke
  are prerequisites, not optional release switches. Failure, cancellation or missing
  verification must not authorize publication.
- OMC updates require the Ed25519-signed manifest and pull its immutable image digest.
  No public key, a wrong key or a bad signature means no automatic OMC update.

The executable publication contract is in
[release.yml](../.github/workflows/release.yml) and the release scripts it calls.
[Testing](testing.md) owns CI topology and verification commands; this guide owns the
maintainer procedure and recovery requirements.

## One-time credentials

Configure `DOCKERHUB_TOKEN` as an Actions secret with access to the image repository.
Keep the repository public for unauthenticated installations. Use the job-scoped
`GITHUB_TOKEN` for release creation; no personal token is needed. Never paste values
into issues, logs, source or chat.

```bash
gh secret set DOCKERHUB_TOKEN --repo WizisCool/oh-my-cpa
```

Generate the release signing key once on a trusted machine:

```bash
node scripts/sign-release-manifest.mjs --generate-key release-signing-key.txt
gh secret set RELEASE_SIGNING_KEY --repo WizisCool/oh-my-cpa < release-signing-key.txt
```

This writes the private key to the named file and the public key to
`internal/updater/release_public_key.txt`. Commit only the public key. Securely store
the private key offline and remove its working-directory copy before committing.
The Actions secret cannot be read back. A missing secret or a mismatch with the
committed public key must fail signing.

Replacing the key pair makes existing installations reject new manifests. Those
installations require one manual upgrade to a build carrying the new public key;
do not add an unverified fallback. Forks that do not configure a key cannot offer
signed automatic OMC updates.

## Prepare and publish

1. Update root and web package versions together and add user-visible changes and
   upgrade notes under [`docs/releases`](releases). Keep lockfile metadata consistent.
   The installation guides use stable aliases, so they do not need a version bump.
2. Run the checks required by [Testing](testing.md). Land the preparation on `main`
   and wait for that exact commit's main CI to be green. A release-preparation PR may
   use `chore(release): prepare vX.Y.Z` so automated review does not re-review notes
   about already reviewed changes.
3. From a clean checkout of that verified commit, derive and publish its tag:

   ```bash
   git switch main
   git pull --ff-only
   test -z "$(git status --porcelain)"
   TAG="v$(node -p 'require("./package.json").version')"
   # Confirm HEAD is the main commit whose CI you just checked.
   git tag -a "$TAG" -m "Oh My CPA $TAG"
   git push origin "$TAG"
   ```

4. Follow the release workflow. Verification precedes packaging. The container is
   smoke-tested in its non-root/read-only form, with SQLite, health, login, root and
   configured base paths, running version and updater installation exercised. Image
   publication includes provenance and SBOM. Native packaging runs from the same
   verified source; its extracted Linux package is smoke-tested.
5. After image and native assets succeed, release publication revalidates attachments,
   signs `release-manifest.json` and stages the GitHub release as a draft. It publishes
   only after every attachment succeeds. Docker `latest` promotion follows public
   release publication and rechecks that a newer version has not appeared.
6. Verify the public manifest, image and native assets. Check an installation's running
   version and update observation. Versioned pulls must work independently of `latest`.

## Native packages

The platform matrix and filenames are declared in
[`native-release.mjs`](../scripts/native-release.mjs). It currently covers Darwin,
Windows, Linux and FreeBSD on amd64/arm64, with zip for Windows and tar.gz elsewhere.
Each archive includes the executable, license, READMEs, installation/operations/SQLite
guides and a native environment example. It contains no secrets or runtime data.

Builds use `CGO_ENABLED=0`, modernc SQLite and embedded time-zone data. Native hosts
still need certificate roots for HTTPS. Darwin and Windows packages are not signed
or notarized. Linux CI cross-compiles foreign targets; it does not execute all eight.

`checksums.txt` covers all native archives and Compose/CPA installation attachments.
The release manifest and its signature are verified separately. Package builders use
frozen dependencies and do not restore shared dependency/build caches into publication
inputs. Keep this isolation even if routine CI uses caches.

To reproduce packaging on Linux with the pinned toolchains, GNU tar, zip and unzip:

```bash
pnpm install --frozen-lockfile
RELEASE_TAG=v$(node -p 'require("./package.json").version') node scripts/native-release.mjs
RELEASE_TAG=v$(node -p 'require("./package.json").version') node scripts/native-release-smoke.mjs
```

The builder produces the SPA once, verifies Go metadata, normalizes archive metadata
and validates checksums. A clean output directory prevents stale assets entering a
retry. Review the generated artifacts, not just successful cross-compilation.

## Recovery and observation

Release jobs serialize rather than cancel an in-flight publication. If verification
fails, fix the cause; do not bypass it. If an image upload succeeded but attachments
failed, retry the failed release job for the same verified source. The GitHub release
stays draft and update checks ignore it until attachments finish. If only `latest`
promotion failed, versioned pulls still work; retry promotion rather than republishing.

Manual workflow dispatch can recover an existing tag. It resolves and verifies that
tag's immutable source, regardless of the dispatch branch. A runner/workflow-only
repair can be merged before dispatch; application changes require a new version.
Assets can be revalidated and replaced for the same source without recreating the
release or moving its tag. Latest-version policy must be checked again on retries.

Update observation uses GitHub stable release metadata, not registry tags. It ignores
drafts/prereleases and retains the last successful result after a failed fetch. Cached
results and the attempt floor can delay a post-release observation; do not weaken the
floor to force an immediate fresh result. See [Update checks](operations.md#update-checks).
