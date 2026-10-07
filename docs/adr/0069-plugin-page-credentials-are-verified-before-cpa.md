# ADR 0069: Plugin page management credentials are verified before CPA

- Status: Accepted
- Date: 2026-10-07
- Supersedes ADR 0067's decision to forward explicit Authorization and X-Management-Key
  to CPA for validation, and its authentication of native writes against the fixed
  version read. Everything else in ADR 0067 stands.

## Context

ADR 0067 forwarded a hosted page's explicit management credential so that CPA, not the
host, decided whether it was valid. CPA counts failed management authentications per
client address and bans the address for 30 minutes after five failures; the ban is
checked before the key, so a banned address is refused even with the correct key.

Every hosted page reaches CPA from the Oh My CPA process. A plugin page that asks the
operator for a management key therefore spent the console's own ban budget on each
mistyped key. A few wrong entries left every CPA-backed console feature refused -
configuration, providers, credentials, plugins and usage collection - until the ban
expired or CPA restarted. The collector already treats that budget as scarce
(`AuthCooldown` in `internal/usage/ingest/runner.go`).

## Decision

No credential supplied by a page is sent to CPA's management API.

`PluginRoute` reads a page's credential with CPA's precedence: a Bearer Authorization,
otherwise the raw Authorization value, otherwise X-Management-Key. When either header is
present, even empty, the credential is compared in constant time with the instance's
stored management key. A mismatch is answered `401` in CPA's wire shape
(`invalid management key`, or `missing management key` for an empty credential) with no
upstream request, configuration backup or write. A match, and a page that sends neither
header, proceed with the stored key as the only credential on the upstream request.

Native writes no longer authenticate against the version read first: the page
credential is already settled before the pre-write backup is taken.

The call is still audited as `plugin.route_call`, with the refusal recorded as a failed
outcome with status 401. Resource and model-directory credential rules are unchanged.

## Consequences and trade-offs

A wrong key typed into a plugin page still fails visibly, which was the reason ADR 0067
stopped replacing page credentials, and it can no longer lock the console out of CPA.

The host accepts only the key stored for the instance. Another secret CPA would honour,
such as `MANAGEMENT_PASSWORD` when it differs from the configured key, is refused on this
surface. That is accepted: the stored key is the one every other console feature
depends on, and the page already holds the operator's session authority.

Local refusals are not rate limited. They require an authenticated console session,
whose sign-in is itself throttled, and a session can already act through the host with
the stored key without presenting one.

The refusal text mirrors CPA's but is produced here; a change to CPA's wording does not
propagate. Pages are expected to branch on the status.
