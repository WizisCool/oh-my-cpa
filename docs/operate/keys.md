# Keys

Two secrets hold a deployment together. Keep both out of chat logs, screenshots and
shell history.

## The master key

`OMCPA_MASTER_KEY` encrypts credentials, captured payloads and backups inside OMC's
database. Generate it once (`openssl rand -hex 32`), back it up with `.env`, and never
change it once data exists: without it the stored data is unreadable. The
[backup runbook](../ops/sqlite-operations.md#4-omcpa_master_key-governance--disaster-prevention)
covers what a backup needs to stay restorable.

## Rotating the CPA management key

The CPA management key is deployment-owned: it authenticates OMC's management
clients and usage collector, signs console sessions, and authorizes remote MCP
calls. The visual configuration editor shows it read-only; OMC refuses ordinary
configuration writes or backup restores that would change it. A CPA-only write
would leave the running clients and login verifier on the old value, and an
unchanged `OMCPA_CPA_MANAGEMENT_KEY` would restore that value on the next start.

Trusted plugin pages are the native-response exception. A Plugin Host request can
reach CPA's native configuration tree, including `/v8/management/config.yaml`, so
it can change the management key without this check. Do not rotate the management
key through a plugin.

Rotate both processes from one deployment change:

1. Back up the environment file and OMC's data directory.
2. Set CPA's management key and OMC's `OMCPA_CPA_MANAGEMENT_KEY` to the same new
   value. In the full-stack Compose file, set `CPA_MANAGEMENT_KEY` once: it supplies
   both CPA's `MANAGEMENT_PASSWORD` and OMC.
3. Recreate both Compose containers so they load the updated environment:
   `docker compose up -d --force-recreate cpa oh-my-cpa`. `docker compose restart`
   keeps the old container environment and is not sufficient.
4. Sign in with the new key. Sessions signed with the old key are invalid.

For an existing CPA on separate hosts, update its `management.secret-key` (or
`MANAGEMENT_PASSWORD`) and OMC's environment in the same maintenance window, then
stop and start both processes so they load the new values.
