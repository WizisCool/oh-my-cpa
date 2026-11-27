# Quota and warmup

## Quota refresh

Quota observations are initiated server-side against fixed provider
endpoints (`internal/quota/service.go`) or CPA's plugin quota endpoint. **OMC Settings →
Quota** (`omc_quota_auto_refresh`) controls automatic post-reset reads and scheduled
sweeps, and automatically clears CPA cooldowns when all windows have room or recovery
times have passed. That release is credential-wide, so it is withheld while any model on
the credential is still resting. Claude quota reads serialize and respect `Retry-After`
backoff; Meta Muse credentials refresh only on manual request.

## Cooldown scope

CPA cools a credential or one of its models. The Quota page lists a
model-scoped cooldown with its own recovery and retry instant and the gateway's backoff
level, and reports it as partial: the credential keeps serving its other models. Spellings
that resolve to one upstream model - a mixed-case id, or an OAuth alias recorded before CPA
resolved it - are listed once, keeping the later recovery time. When CPA's live credential
projection affirmatively reports a credential available, quota reads reconcile stale local
credential-scoped cooldown evidence up to the pre-read watermark without issuing a
credential-wide CPA reset, leaving independent model cooldowns intact.

## Window warmup

OAuth management's **Warmup settings** drawer holds warmup
tasks. A task names one credential and one trigger: after a quota window resets, daily at
a chosen time and zone, or every N hours from an anchor. Its model stays empty by default:
the run then uses the credential's cheapest model priced above zero, so the request neither
burns a premium model nor lands on the free model that starts no window; when the book
prices none of them, the lightest name answers. An OAuth model alias counts as the model it
reaches, and the alias is what is sent. A run is a credential-pinned text completion through
CPA's `credentials/verify`, so a successful run is recorded as `ok`. Window tasks read the
credential's quota first and retry a failed read after five minutes.

## Warmup safety

A run's record is written before the request is sent, and a run whose
record cannot be written is not sent. A run reads its task again as it starts: a task deleted
a moment earlier sends nothing, one switched off does not run on schedule, and a task cannot
be deleted while its run is in flight. Disabled and unavailable credentials are refused as
`credential_disabled` and `credential_unavailable` instead of being woken. An outcome left
uncertain by the transport or by an OMC restart is recorded as unknown and never resent
automatically. Each task keeps its newest 50 run records.
