# ADR 0094: Quota readings refresh in the background

- Status: Accepted, amended 2026-10-22 (see "A failed read leaves a trace for the console" and "A CPA cooldown ends when the credential can serve again")
- Date: 2026-10-12

## Context

Every quota reading was operator-initiated: a refresh button in the OAuth management
workspace, the dashboard's Credential Quota panel, the credential Drawer, or an Agent
call. Between clicks the stored observation aged, and the case operators wait on most
aged worst: a credential whose window was exhausted kept reading as exhausted after its
window had reset, until someone thought to refresh it. The stored reading already
carried the instant that would change - each window's `reset_at_ms` - so the console
knew when its own answer had become wrong and did nothing about it.

A background read is not free. Each one is a request to the provider made with the
credential itself, relayed by CPA (its `api-call`, or the plugin's quota endpoint for a
plugin credential), and a deployment can hold many
credentials. One provider's read has a side effect: Meta's observation exchanges the
stored DCA token for a key upstream, and that exchange is audited per attempt as an
operator's action.

## Decision

**A one-minute background loop re-reads credentials that are due, under a stored
policy with two independent triggers.** `Handler.RunQuotaAutoRefresh`
(`internal/api/quota_auto_refresh.go`), started by `app.Run`, reads the
`omc_quota_auto_refresh` preference on every tick, so a change takes effect without a
restart. The rules are pure functions in `internal/quota/auto_refresh.go`.

- **Reset-driven read** (`refresh_on_reset`, on by default): a credential is read once
  a window its latest stored observation reported has passed its reset by
  `AUTO_REFRESH_RESET_GRACE` (one minute), on the first tick after that instant. A read
  that fails is not stored, so it is retried every ten minutes during the hour after the
  reset and then left for the operator or the schedule; a credential nobody has read has
  no boundary and is never read by it.
- **Scheduled read** (`interval_minutes`, 360 - six hours - by default, 5-1440, or 0
  for off): a credential
  is read once the newer of its observation and the last attempt is that old,
  including a credential nobody has read. A thirty-second slack lets the read fire on the
  tick that ends the interval, because an observation is stamped when its read finishes.

Both triggers are on by default. A reset-driven read only re-reads a credential an
operator already read, once per boundary that reading announced. The six-hour schedule
keeps no reading older than the shortest common window (five hours) is long, so a
credential nobody has opened still has a recent reading, at four reads per credential a
day; a deployment holding many credentials or wanting fewer upstream requests can
lengthen it or turn it off.

**Automatic reads reuse the manual path and its persistence rule.** A due credential
is read by `quota.Service.RefreshCredentialQuota` and stored by the same function a
manual refresh uses, so a failed or stale read never replaces the last good
observation. Because a failed read is not stored, the loop remembers its attempts in
process memory, and both triggers count from the attempt as well as the observation:
a credential that keeps failing is not re-read every minute. `app.Run` joins the loop
before returning, because a round in flight writes to the database the caller closes.

**Bounds.** A round reads at most sixteen credentials, four at a time; the rest stay
due for the next tick. Disabled credentials, providers without a probe, and an
`auth_index` two credentials claim are never read. Meta is never read automatically,
because a timer must not mint keys an audit trail records as operator decisions.

**The policy is a validated preference.** The preference API accepts this key only as
`{"interval_minutes": int, "refresh_on_reset": bool}` within the bounds and answers
`invalid_quota_auto_refresh` otherwise, because the server acts on it. The loop reads it
field by field: a field it cannot read takes its default while the other keeps the
operator's value, so a document a newer build wrote cannot turn reads the operator
switched off back on. `quota_auto_refresh_get` and
`quota_auto_refresh_set` expose the same policy to the Agent and MCP.

**A demonstration never starts the loop.** Its gateway is the fixture, and the
demonstration starts no loop of its own beyond the HTTP server.

**A failed read leaves a trace for the console, not an observation.** Because a failed or
stale read is never stored, the stored reading could not say that the console's own
refreshes had stopped working: the operator saw a toast, and the page went on presenting a
reading days old as the current answer. Migration 044 adds `quota_refresh_attempts` - one
row per credential, holding when the last read was attempted, whether it produced a
reading and the provider's redacted reason, stamped when the read starts so two
overlapping reads are ordered by start rather than by which response landed last - written
by the one helper every read path goes through, and served as `last_refresh` beside the
reading. The status the console
presents then follows `quota.ApplyReadingHealth`: a failed attempt newer than the reading
outranks it (auth-like failures as `error` with the reauth recommendation, the rest as
`stale` with the previous numbers standing, or as `error` when the credential holds no
observation at all and nothing on screen could be called out of date), an active cooldown
outranks both, and a healthy or warning reading whose own announced reset has passed unseen
reads as `stale`.
Recording an attempt does not change the cadence: the loop's retry backoff stays
in-process memory, so a restart still re-reads a failing credential once.

**A CPA cooldown ends when the credential can serve again.** A usage-limit refusal leaves
`quota_exceeded` evidence in `error_events` with the recovery time CPA announced, and the
credential stays in cooldown until someone clears it. Two facts now end that cooldown on
their own, each with the same CPA `routing/cooldown/reset` call and evidence wipe the
operator's Clear Cooldown performs. First, a read through `Handler.refreshQuotaReading`
that is fresh, usable and shows room in every published window
(`quota.HasRestoredCapacity`) releases a credential that still holds evidence, whichever
surface asked for the read: providers reset quotas before the recovery time they
announced, and the credential could serve again. Second, each round of the loop releases
an enabled credential whose every stored recovery and retry time has passed
(`Repository.BatchExpiredCooldowns`, with no lookback window), including providers the
loop never reads, because a clear is not a read. A newer cooldown that has not recovered
yet keeps the credential blocked even when an older one has passed, and a clear that fails
waits out the ten-minute retry backoff before it is tried again. Each release is
logged with its `auth_index` and audited as `quota.clear_cooldown.automatic` with the
reason `capacity_restored` or `recovery_time_passed`; a CPA failure keeps only its HTTP
status. The second runs only inside the loop, so a deployment with both triggers off
keeps operator-only clears for expired cooldowns.

## Consequences

- An exhausted credential reads as recovered about a minute after its window resets,
  with no operator action, and the console pages that poll the stored readings - the
  dashboard panel and the OAuth management workspace, each every minute - show it.
- A deployment upgraded to this version starts reading its credentials on its own:
  within its first minutes every enabled credential whose reading is older than six
  hours, or that nobody has read, is read (sixteen per minute), then each about every
  six hours and after each reset. Turning both triggers off restores operator-only
  reads.
- The attempt memory is lost on restart, so a failing credential that is due may be
  tried once more after a restart; the round limit still bounds that.
- The readings remain `quota_snapshots` rows; migration 044 adds only the per-credential
  attempt record the console reports beside them.
- A credential whose quota came back early, or whose recovery time has passed, serves
  again without an operator clearing its cooldown. A read that reports capacity the
  provider then refuses produces a fresh usage-limit error, so CPA puts the credential
  back in cooldown until the next read.
- A failure now outlives its toast: a page opened later still says the last refresh failed
  and when, and a credential whose reading is older than the boundary it announced no
  longer reads as healthy.
