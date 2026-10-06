# Native archives share the gated release pipeline

OMC publishes native executables for CPA's Darwin, Windows, Linux and FreeBSD
amd64/arm64 matrix through the existing tag workflow, alongside Docker images.
The matrix and archive/checksum contract are repository-owned and tested: the build
uses one embedded SPA, CGO-free Go and injected release identity, while publication
requires full verification, a successful versioned image push and validated native
assets. This extends ADR 0056's publication gate without delegating GitHub publication
or latest selection to a second release engine.

Native archives provide the executable, license, READMEs, operator guides and a secret-free environment
template; SHA-256 checksums cover all downloadable archives and installation files.
The source commit date normalizes archive timestamps. A pinned artifact transfer
separates read-only builds from the only repository-write job, which rechecks the
complete manifest before publishing. New releases stage as drafts until all attachments
finish, then recheck latest policy immediately before becoming visible. Docker latest promotion and GitHub's numerical
stable selection retain their existing ordering. Backports and retries cannot lower
either latest pointer. Cross-compilation is checked for every target, while an extracted
Linux package supplies runtime evidence; unsigned Darwin/Windows executables and
foreign runtime coverage remain explicit distribution constraints.
