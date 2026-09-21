# ADR 0019: Version observation is a state, and its change log is fetched per product

- Status: Accepted
- Date: 2026-09-22

## Context

The System Information page reported a version comparison as a boolean derived from
string inequality: `latest_version != cpa_version`. That treats `7.3.5` and `7.3.11`
as different in the right direction by luck rather than by rule, ignores direction
entirely, and cannot express the case the project actually ships — `OMCPA_VERSION`
defaults to `v0.1.0-dev` and the public demo builds as `v0.1.0-demo`, neither of which
is a release version at all. A failed check was indistinguishable from "up to date",
because both produced an empty `latest_version`.

The running gateway version was also learned as a side effect of a lookup that
depends on reaching GitHub, so a deployment that could not reach the internet could
not say which gateway version it was running.

Adding release notes raised three further questions that the code cannot answer for
itself:

1. Release notes come from a third-party host (`api.github.com`), reached by the
   server rather than the browser. Its unauthenticated budget is 60 requests per hour
   per address, so "fetch on render" would spend the operator's whole allowance on
   reloads.
2. Notes are untrusted remote Markdown, rendered into the console.
3. The console has no release history of its own: the repository has no releases or
   tags, so its own change log is legitimately empty today.

## Decision

**A comparison is a state, not a boolean.** `update_available`, `up_to_date`,
`update_ahead`, and `indeterminate`, where `indeterminate` carries a reason. Only
versions that parse as plain dotted release versions are compared. A suffixed build
version (`-dev`, `-demo`, a fork's marker) reports `indeterminate` with a reason
rather than "up to date" or "behind": the console cannot place such a build on the
release line, and inventing a position for it would be a precise-looking wrong answer.
A build newer than every release reports `update_ahead`, because "ahead of publication"
is not an update to install.

**The running gateway version is read from the gateway**, from the response headers of
a management endpoint the page already calls, independently of whether any release
check succeeded.

**The change log covers a computed interval, not everything.** For each product, the
stable releases in `(running, newest]`, grouped by version, newest first, ordered by
version rather than by publication time so a backport published later does not appear
above a newer release. Prereleases are excluded. When the running version is not
comparable no interval is claimed and the newest release is shown alone.

**The versioned metadata is stored; the notes are not.** `release_index` and
`release_check_state` (migration 024) hold tags, names, dates, prerelease flags and
the check outcome, so "is there a newer version" survives a restart and works offline.
A release body is held in process memory only and is never written to the database that
holds the audit trail. The consequence is visible rather than hidden: the page reports
whether it holds notes and renders an entry with its version, date and source link when
it does not, instead of an empty change log that would read as "nothing changed".

**A conditional request's validator is trusted only with its body.** A `304` is answered
against a representation the process must still hold, so stored ETags are dropped at
start-up and the first check after a restart is unconditional. Validators are also only
sent when the cached snapshot came from a single page: page one's validator says nothing
about page two, and treating it as a whole-snapshot answer would leave the older pages
unverified while the code assumed they were current. Conditional requests are used because
they can avoid transferring a body the process already holds; whether GitHub also excludes
them from rate-limit accounting is not something this project relies on, and the operator's
budget is treated as spent either way.

**A check is subject to a floor, and failures never overwrite the answer.**
`CheckFloor` (fifteen minutes) is the shortest interval between two real reads of the feed.
Opening the page and the manual button still check on every use, but inside the floor the
answer comes from the stored index and the response says so (`served_from_cache`), so the
button never claims a check it did not perform. A sweep runs every six hours and is exempt
because it is far outside any floor (`OMCPA_UPDATE_CHECK_ENABLED=false` stops the sweep
only). A failed check leaves the stored index and the last-success timestamp intact and
records the reason and the attempt time, so the page reports the previous answer and why the
new attempt failed. The floor is measured from the last attempt rather than the last
success, so a broken feed is not retried on every page view. Each product is checked and
reported independently. A conditional request's validator is trusted only while the process
still holds the body it describes, so stored ETags are cleared at start-up.

**Rendering does not execute remote content.** Release bodies render through
`react-markdown` without `rehype-raw`, so HTML in a release body is never executed;
images are rendered as links rather than loaded, so opening the page makes no request
to a third-party host; external links open in a new tab with `noopener noreferrer`.

**The source is a repository identifier, never a URL.** The host is
`api.github.com` as a compile-time constant; only `owner/name` is configurable
(`OMCPA_OMC_REPO`, `OMCPA_CPA_REPO`) and it is validated by shape before use. The
process follows `HTTP_PROXY`/`HTTPS_PROXY`, matching the pricing sync, because both are
reads of a fixed public endpoint.

**The demonstration answers from a fixture and performs no outbound request.** The
demo builds the production service with only its feed source swapped, so the page
demonstrates the real comparison and the real merged log, and its release routes are
refused by the demo policy table (`internal/api/demo_policy.go`).

## Consequences

- The console can now be wrong in a visible way it could not before: it can say "I
  cannot tell whether you are up to date". That is the intended trade — the previous
  behaviour asserted currency on no evidence.
- A restart costs one unconditional request per product, because validators are
  dropped with the bodies they described.
- Sixty unauthenticated requests per hour per address is the real ceiling. A check costs one
  request per product and a second only when a feed's first page is full, and the floor caps
  how often that can happen: at most a handful of checks an hour, so the budget is shared with
  whatever else the operator runs rather than consumed by page views. If it is still reached,
  the page keeps the previous index, names the reset time, and does not silently present stale
  data as current.
- The console's own change log stays empty until the project publishes releases. The
  page states that rather than hiding the card, and no release automation was added.
- Notes are unavailable after a restart until the next successful check. Storing them
  was considered and rejected: it would put arbitrarily large, untrusted, third-party
  text into the database that holds the audit trail, for a page whose other half works
  without it.

## Alternatives considered

- **Store notes in SQLite.** Rejected for the reason above; the split is now visible in
  the UI, which is what makes the simpler choice defensible.
- **Throttle the manual check.** Rejected at first on the operator's explicit choice of an
  unthrottled check with the quota consequence stated. That choice was then reversed by
  measurement rather than argument: the sixty-request hourly budget was exhausted in
  practice, by page loads at up to two requests per product, and the console reported the
  exhausted limit in place of a version. The floor that replaced it keeps the visible
  behaviour honest instead of hiding the change - a call inside the floor still answers, and
  it reports that the answer came from the store.
- **Discard bodies and re-fetch per release.** Rejected after checking the API: the
  list response already includes bodies, so discarding them costs extra requests rather
  than fewer.
- **Read only CPA's `/latest-version` and skip GitHub for the gateway.** Rejected
  because that endpoint reports a version number and no change log, which is the whole
  feature.
