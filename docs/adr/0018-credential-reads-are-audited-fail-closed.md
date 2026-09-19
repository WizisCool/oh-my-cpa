# ADR 0018: Credential-bearing reads are audited fail-closed, once per reveal

- Status: Accepted
- Date: 2026-09-20

## Context

The audit stream recorded every credential change but no credential read. The raw
configuration source was already covered by `config.reveal_source`, and
`/management/config` returns only `safe_yaml`, so neither is the remaining gap.
The two list responses that can carry plaintext credentials are:

- `GET /management/api-keys?include_keys=true`, which the key page needs to join
  aliases and usage against the key text; and
- `GET /management/providers?include_keys=true`, which the provider editor needs
  to edit upstream keys.

Without a read record, the audit log could not answer the incident question "who
read the keys, and when". The decision is not mechanical because a failed audit
write can make a read unavailable, and because these lists can be polled.

## Decision

1. **Audit the response that actually carries credential material.** A masked
   list is a metadata read and is not recorded. `include_keys=true` on the two
   list endpoints is the audit boundary; the raw source continues to use
   `config.reveal_source`.
2. **Fail closed.** The audit record is written after the credentials have been
   read but before the response is emitted. If the audit store is unhealthy, the
   response is `500` and no credential is returned. This mirrors the repository's
   existing rule for sensitive exports and raw-source reveals.
3. **Record one event per reveal, not one per credential.** The event identifies
   the list and carries counts (`key_count`, and `provider_count` where relevant),
   so an audit review can see the scope without turning one page load into a row
   per key. Masked polling stays outside the log.
4. **Give each surface its own action and target.** Caller-key reads use
   `api_key.reveal` with target `client_api_key/list`; provider-key reads use
   `provider.reveal_keys` with target `provider/list`.

## Consequences

- The key and provider pages cannot load their editing state while the audit store
  is unavailable. That availability loss is accepted for an explicit credential
  reveal; the masked list remains usable while the audit store is unhealthy.
- A page refresh or query refetch records another read. The log stays bounded by
  the explicit opt-in and by one record per response, not by one record per key.
- Audit details contain counts and list identities only. No credential value,
  key fingerprint or other secret-bearing material is copied into the audit row.
