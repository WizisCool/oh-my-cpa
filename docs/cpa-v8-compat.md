# CPA v8 compatibility

Oh My CPA (OMC) works against CLIProxyAPI (CPA) v7 and v8 gateways from one build. This
document records what v8 changed, what was measured against real binaries, how OMC
decides where a setting lives and which API it calls, and what remains unverified.

Upstream sources, all at tag `v8.0.2` (commit `4a2c818`):

- [management-api-v8.md](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.2/docs/management-api-v8.md) — the v8 Management API.
- [config.example.yaml](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.2/config.example.yaml) — the v8 template; its closing
  "Legacy compatibility reference" lists only the most common relocations.
- [config_v8.go](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.2/internal/config/config_v8.go) — the complete relocation table
  (`buildV8Paths`, `v8KeyFamilies`) and the precedence and migration code. **This file,
  not the template, is authoritative**: the template reference omits most entries.
- [server_management_v8.go](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.2/internal/api/server_management_v8.go) — the v8 routes
  and the handler each is registered on.

`v7.3.20 → v8.0.2` is seven commits, all in configuration structure and the Management
API. Client-facing proxy protocols (`/v1`, `/v1/responses`, websocket) are unchanged.

## 1. What v8 changed

**Configuration layout.** Most settings moved under nine v8 sections (`server`,
`management`, `access`, `credentials`, `routing`, `requests`, `oauth`, `multimedia`,
`observability`); `config-version: 8` marks a migrated file. The root `api-keys` key
changed meaning: in v7 it is the client-key list, in v8 it is a mapping of upstream
provider groups (`api-keys.codex`, …), and client keys moved to `access.api-keys`. CPA
tells the two apart by shape (list vs mapping).

**Management API.** A new `/v8/management` tree: path-addressed configuration reads and
writes (`/config/<section>/<field>`), grouped operational routes, and a unified OAuth
entry. `/v0/management` is kept in full, including the flat setters (`/debug`,
`/request-retry`, …) and the per-family credential lists (`/codex-api-key`, …), which
exist only under v0.

### Migration and precedence semantics (measured)

Measured on `eceasy/cli-proxy-api:v8.0.2` with a legacy file derived from the v7.3.20
`config.example.yaml` (client keys, one `codex-api-key` entry, one unknown section added).

| Rule | Result |
| --- | --- |
| Starting v8 on a legacy file leaves the file unchanged | Pass: byte-identical after start-up |
| v8 GET requests leave the file unchanged | Pass: byte-identical after `GET /v8/management/config`, `/config/config-version`, `/config/access/api-keys` and operational GETs |
| One successful v8 write (`PUT /v8/management/config/observability/logs/debug`) migrates and rewrites the whole file | Pass: 1025 → 377 lines, `config-version: 8` added, every relocated setting moved, indentation changed to four spaces, comments of moved keys kept |
| Legacy keys are deleted on migration | Pass: no relocated legacy key left at the root |
| Unknown sections are kept as comments | Pass: `omc-operator-notes` became a commented block at the end of the file |
| When both spellings exist, the v8 one wins and the legacy one is dropped | Pass: see §4 — the legacy values were discarded and absent from the file after the save |
| `PUT /v0/management/config.yaml` accepts any layout | Pass, **and it answers `200` while discarding every shadowed legacy key** |
| v0 flat setters on a migrated file write the v8 location | Pass for `debug`, `proxy-url`, `request-retry`, `max-retry-interval`, `max-retry-credentials`, `routing/strategy`, `force-model-prefix`, `ws-auth`, `logging-to-file`, `usage-statistics-enabled`, `logs-max-total-size-mb`, `error-logs-max-files` |
| …when the v8 location is absent from the file | The setter writes the **legacy** key at the root and it takes effect (`request-log` after migration, which the migrated file did not carry) |
| `PUT /v0/management/api-keys` on a migrated file | Pass: written to `access.api-keys`; the provider groups are untouched |
| `PUT /v0/management/codex-api-key` on a migrated file | Pass: written as `api-keys.codex` groups (`codex-1`, `codex-2`); no root `codex-api-key` |
| A v7 gateway answers `/v8/*` | 404 for every path, including `/v8/management/config/config-version` |

Two more precise statements than the usual summary:

- Legacy spellings are removed on load or save **only when their v8 twin is present**.
  A legacy-only setting keeps working in its old place until a v8 configuration write
  migrates the file. Precedence is per leaf: a legacy `tls.cert` beside a v8
  `server.tls.enable` is honoured, while a legacy `oauth-model-alias` map loses entirely
  to any v8 `oauth.model-alias` map, whatever providers each names.
- `GET /v8/management/config.yaml` returns the *migrated view* of the file, not the file;
  `GET /v0/management/config.yaml` returns the file as stored. OMC reads the latter.

Observed but not part of the v8 change: several v0 writes sent back to back without a
pause can lose all but the last (each write reloads the configuration asynchronously).
It was seen on v8.0.2 during a scripted burst; it was not tested on v7. OMC's own writes
are serialised by its provider write gate and are one operator action at a time.

## 2. Review of the relocation list in the task brief

The brief's mapping was checked against `config_v8.go` rather than the template. Every
entry the brief marked as known is correct except one; every low-confidence entry is
resolved below.

| Brief | Actual | Note |
| --- | --- | --- |
| `host`/`port` → `server.*` | Correct | |
| `remote-management.*` → `management.*` | Correct | |
| `api-keys` → `access.api-keys` | Correct | Only while the root value is a list; a root mapping is v8 provider groups |
| `codex-api-key` → `api-keys.codex` | Correct, with a shape change | One group per legacy entry (`name: codex-N`, group-level `base-url` and shared fields, key material in `keys:`); the same holds for `gemini`, `interactions`, `vertex`, `claude`, `xai`, `meta` and `openai-compatibility` (whose `api-key-entries` become `keys`) |
| `request-retry` → `routing.retry.request-retry` | Correct | `max-retry-credentials`, `max-retry-interval` move beside it |
| `debug` → `observability.logs.debug` | Correct | |
| `proxy-url` → `requests.proxy-url` | Correct | |
| `auth-dir` → `oauth.auth-dir` | Correct | |
| `codex.*` → `oauth.providers.codex.*` | Correct | |
| `antigravity-credits` → `oauth.providers.antigravity.antigravity-credits` | **Source path wrong** | The legacy key is `quota-exceeded.antigravity-credits`, not a root key |
| `auth-auto-refresh-workers` (low confidence) | `oauth.auth-auto-refresh-workers` | Confirmed |
| `payload.*` (low confidence) | `requests.payload.*` | Under `requests`, not a root `payload` |
| `passthrough-headers` (low confidence) | `requests.passthrough-headers` | Confirmed |
| `streaming.*` (low confidence) | `requests.streaming.*` | Confirmed |
| `commercial-mode` (low confidence) | `server.commercial-mode` | Confirmed |
| `disable-cooling` (low confidence) | `routing.cooldown.disable-cooling` | Confirmed |
| `quota-exceeded.switch-project`, `switch-preview-model` | Legacy-only | No v8 counterpart; they stay under `quota-exceeded` in both layouts |

Relocations the brief did not list include `nonstream-keepalive-interval` →
`requests.nonstream-keepalive-interval`, `ws-auth` → `oauth.providers.aistudio.ws-auth`,
`force-model-prefix` → `routing.force-model-prefix`, the other `observability.logs.*` and
`observability.usage.*` settings, `tls` → `server.tls`, both header-default sections, the
flat `antigravity-signature-*` keys, `multimedia.*`, and `oauth.model-alias` /
`oauth.excluded-models` / `oauth.request-scoped-errors`. `routing.strategy`,
`routing.session-affinity*` and `plugins.*` keep their paths. The complete list is §3.

Checking OMC's editor against the real table also exposed two editor paths that were
wrong for v7 as well, now fixed: the Antigravity signature switches wrote
`antigravity.signature-cache-enabled` / `antigravity.signature-bypass-strict`, which CPA
never reads (the real keys are the flat `antigravity-signature-cache-enabled` /
`antigravity-signature-bypass-strict`), and the non-streaming keepalive wrote a duration
string under `streaming`, while CPA reads an integer number of seconds at the root.

## 3. Complete legacy ↔ v8 mapping

This is `internal/cpa/configyaml/layout_rules.go`, which is CPA's own table. The console
receives the same rows from `GET /management/config`, so the two cannot drift.

### Settings (leaves)

A leaf is the unit of CPA's precedence rule. "OMC editor field" names the configuration
page field that edits it.

| v8 section | Legacy path | v8 path | OMC editor field |
| --- | --- | --- | --- |
| `server` | `commercial-mode` | `server.commercial-mode` | `commercialMode` |
| `server` | `discovery.advertise-management` | `server.discovery.advertise-management` | — |
| `server` | `discovery.auth-required` | `server.discovery.auth-required` | — |
| `server` | `discovery.enabled` | `server.discovery.enabled` | — |
| `server` | `discovery.interfaces.exclude` | `server.discovery.interfaces.exclude` | — |
| `server` | `discovery.interfaces.include` | `server.discovery.interfaces.include` | — |
| `server` | `discovery.service-name` | `server.discovery.service-name` | — |
| `server` | `discovery.service-type` | `server.discovery.service-type` | — |
| `server` | `discovery.subtypes` | `server.discovery.subtypes` | — |
| `server` | `host` | `server.host` | `host` |
| `server` | `port` | `server.port` | `port` |
| `server` | `tls.cert` | `server.tls.cert` | `tlsCert` |
| `server` | `tls.enable` | `server.tls.enable` | `tlsEnable` |
| `server` | `tls.key` | `server.tls.key` | `tlsKey` |
| `server` | `trusted-proxies` | `server.trusted-proxies` | — |
| `management` | `remote-management.allow-remote` | `management.allow-remote` | `rmAllowRemote` |
| `management` | `remote-management.base-url` | `management.base-url` | — |
| `management` | `remote-management.disable-auto-update-panel` | `management.disable-auto-update-panel` | `rmDisableAutoUpdatePanel` |
| `management` | `remote-management.disable-control-panel` | `management.disable-control-panel` | `rmDisableControlPanel` |
| `management` | `remote-management.panel-github-repository` | `management.panel-github-repository` | `rmPanelRepo` |
| `management` | `remote-management.secret-key` | `management.secret-key` | `rmSecretKey` |
| `access` | `api-keys` | `access.api-keys` | `apiKeys` |
| `credentials` | `credential-concurrency.busy-retry-max` | `credentials.concurrency.busy-retry-max` | — |
| `credentials` | `credential-concurrency.busy-retry-min` | `credentials.concurrency.busy-retry-min` | — |
| `credentials` | `credential-concurrency.cleanup-interval` | `credentials.concurrency.cleanup-interval` | — |
| `credentials` | `credential-concurrency.cpa-cancel-bound` | `credentials.concurrency.cpa-cancel-bound` | — |
| `credentials` | `credential-concurrency.cpa-heartbeat-timeout` | `credentials.concurrency.cpa-heartbeat-timeout` | — |
| `credentials` | `credential-concurrency.lifecycle-config-revision` | `credentials.concurrency.lifecycle-config-revision` | — |
| `credentials` | `credential-concurrency.max-limit` | `credentials.concurrency.max-limit` | — |
| `credentials` | `credential-concurrency.observation-barrier-revision` | `credentials.concurrency.observation-barrier-revision` | — |
| `credentials` | `credential-concurrency.reclaim-grace` | `credentials.concurrency.reclaim-grace` | — |
| `credentials` | `credential-concurrency.release-flush-interval` | `credentials.concurrency.release-flush-interval` | — |
| `credentials` | `credential-concurrency.release-max-backoff` | `credentials.concurrency.release-max-backoff` | — |
| `credentials` | `credential-in-flight.max-aggregate-groups` | `credentials.in-flight.max-aggregate-groups` | — |
| `credentials` | `credential-in-flight.max-details` | `credentials.in-flight.max-details` | — |
| `credentials` | `credential-in-flight.max-part-bytes` | `credentials.in-flight.max-part-bytes` | — |
| `credentials` | `credential-in-flight.max-part-count` | `credentials.in-flight.max-part-count` | — |
| `credentials` | `credential-in-flight.max-revision-bytes` | `credentials.in-flight.max-revision-bytes` | — |
| `credentials` | `credential-in-flight.max-string-bytes` | `credentials.in-flight.max-string-bytes` | — |
| `credentials` | `credential-in-flight.snapshot-interval` | `credentials.in-flight.snapshot-interval` | — |
| `credentials` | `credential-in-flight.staging-retention` | `credentials.in-flight.staging-retention` | — |
| `credentials` | `credential-in-flight.stale-after` | `credentials.in-flight.stale-after` | — |
| `routing` | `disable-cooling` | `routing.cooldown.disable-cooling` | `disableCooling` |
| `routing` | `save-cooldown-status` | `routing.cooldown.save-cooldown-status` | — |
| `routing` | `transient-error-cooldown-seconds` | `routing.cooldown.transient-error-cooldown-seconds` | — |
| `routing` | `force-model-prefix` | `routing.force-model-prefix` | `forceModelPrefix` |
| `routing` | `max-retry-credentials` | `routing.retry.max-retry-credentials` | `maxRetryCredentials` |
| `routing` | `max-retry-interval` | `routing.retry.max-retry-interval` | `maxRetryInterval` |
| `routing` | `request-retry` | `routing.retry.request-retry` | `requestRetry` |
| `requests` | `nonstream-keepalive-interval` | `requests.nonstream-keepalive-interval` | `streamingNonstreamKeepalive` |
| `requests` | `passthrough-headers` | `requests.passthrough-headers` | `passthroughHeaders` |
| `requests` | `payload.default` | `requests.payload.default` | `payloadDefaultRules` |
| `requests` | `payload.default-raw` | `requests.payload.default-raw` | `payloadDefaultRawRules` |
| `requests` | `payload.filter` | `requests.payload.filter` | `payloadFilterRules` |
| `requests` | `payload.override` | `requests.payload.override` | `payloadOverrideRules` |
| `requests` | `payload.override-raw` | `requests.payload.override-raw` | `payloadOverrideRawRules` |
| `requests` | `proxy-url` | `requests.proxy-url` | `proxyUrl` |
| `requests` | `streaming.bootstrap-retries` | `requests.streaming.bootstrap-retries` | `streamingBootstrapRetries` |
| `requests` | `streaming.keepalive-seconds` | `requests.streaming.keepalive-seconds` | `streamingKeepaliveSeconds` |
| `oauth` | `auth-auto-refresh-workers` | `oauth.auth-auto-refresh-workers` | `authAutoRefreshWorkers` |
| `oauth` | `auth-dir` | `oauth.auth-dir` | `authDir` |
| `oauth` | `oauth-excluded-models` | `oauth.excluded-models` | — |
| `oauth` | `oauth-model-alias` | `oauth.model-alias` | — |
| `oauth` | `ws-auth` | `oauth.providers.aistudio.ws-auth` | `wsAuth` |
| `oauth` | `quota-exceeded.antigravity-credits` | `oauth.providers.antigravity.antigravity-credits` | `quotaAntigravityCredits` |
| `oauth` | `antigravity.connection-pool.enabled` | `oauth.providers.antigravity.connection-pool.enabled` | — |
| `oauth` | `antigravity.connection-pool.idle-conn-timeout` | `oauth.providers.antigravity.connection-pool.idle-conn-timeout` | — |
| `oauth` | `antigravity.connection-pool.max-idle-conns-per-host` | `oauth.providers.antigravity.connection-pool.max-idle-conns-per-host` | — |
| `oauth` | `antigravity.sensitive-words` | `oauth.providers.antigravity.sensitive-words` | — |
| `oauth` | `antigravity-signature-bypass-strict` | `oauth.providers.antigravity.signature-bypass-strict` | `antigravitySignatureBypassStrict` |
| `oauth` | `antigravity-signature-cache-enabled` | `oauth.providers.antigravity.signature-cache-enabled` | `antigravitySignatureCacheEnabled` |
| `oauth` | `claude-code.disable-cloaking-model-list` | `oauth.providers.claude.claude-code.disable-cloaking-model-list` | — |
| `oauth` | `disable-claude-cloak-mode` | `oauth.providers.claude.disable-claude-cloak-mode` | — |
| `oauth` | `claude-header-defaults.arch` | `oauth.providers.claude.header-defaults.arch` | `claudeHeaderArch` |
| `oauth` | `claude-header-defaults.os` | `oauth.providers.claude.header-defaults.os` | `claudeHeaderOs` |
| `oauth` | `claude-header-defaults.package-version` | `oauth.providers.claude.header-defaults.package-version` | `claudeHeaderPackageVersion` |
| `oauth` | `claude-header-defaults.runtime-version` | `oauth.providers.claude.header-defaults.runtime-version` | `claudeHeaderRuntimeVersion` |
| `oauth` | `claude-header-defaults.stabilize-device-profile` | `oauth.providers.claude.header-defaults.stabilize-device-profile` | `claudeHeaderStabilizeDeviceProfile` |
| `oauth` | `claude-header-defaults.timeout` | `oauth.providers.claude.header-defaults.timeout` | `claudeHeaderTimeout` |
| `oauth` | `claude-header-defaults.timezone` | `oauth.providers.claude.header-defaults.timezone` | — |
| `oauth` | `claude-header-defaults.user-agent` | `oauth.providers.claude.header-defaults.user-agent` | `claudeHeaderUserAgent` |
| `oauth` | `claude.model-level-cooling` | `oauth.providers.claude.model-level-cooling` | — |
| `oauth` | `codex.disable-codex-cloaking` | `oauth.providers.codex.disable-codex-cloaking` | — |
| `oauth` | `codex-header-defaults.beta-features` | `oauth.providers.codex.header-defaults.beta-features` | `codexHeaderBetaFeatures` |
| `oauth` | `codex-header-defaults.user-agent` | `oauth.providers.codex.header-defaults.user-agent` | `codexHeaderUserAgent` |
| `oauth` | `codex.identity-confuse` | `oauth.providers.codex.identity-confuse` | — |
| `oauth` | `codex.live-media-relay.disable-private-remote-ips` | `oauth.providers.codex.live-media-relay.disable-private-remote-ips` | — |
| `oauth` | `codex.live-media-relay.enabled` | `oauth.providers.codex.live-media-relay.enabled` | — |
| `oauth` | `codex.live-media-relay.ice-servers` | `oauth.providers.codex.live-media-relay.ice-servers` | — |
| `oauth` | `codex.live-media-relay.max-sessions` | `oauth.providers.codex.live-media-relay.max-sessions` | — |
| `oauth` | `codex.live-media-relay.public-ip` | `oauth.providers.codex.live-media-relay.public-ip` | — |
| `oauth` | `codex.live-media-relay.udp-port-max` | `oauth.providers.codex.live-media-relay.udp-port-max` | — |
| `oauth` | `codex.live-media-relay.udp-port-min` | `oauth.providers.codex.live-media-relay.udp-port-min` | — |
| `oauth` | `codex.model-level-cooling` | `oauth.providers.codex.model-level-cooling` | — |
| `oauth` | `codex.optimize-multi-agent-v2` | `oauth.providers.codex.optimize-multi-agent-v2` | — |
| `oauth` | `codex.orphan-delegation-compatibility` | `oauth.providers.codex.orphan-delegation-compatibility` | — |
| `oauth` | `codex.response-steering` | `oauth.providers.codex.response-steering` | — |
| `oauth` | `codex.stream-bootstrap-buffering` | `oauth.providers.codex.stream-bootstrap-buffering` | — |
| `oauth` | `codex.stream-bootstrap-timeout` | `oauth.providers.codex.stream-bootstrap-timeout` | — |
| `oauth` | `devin.sensitive-words` | `oauth.providers.devin.sensitive-words` | — |
| `oauth` | `xai.inject-x-search` | `oauth.providers.xai.inject-x-search` | — |
| `oauth` | `oauth-request-scoped-errors` | `oauth.request-scoped-errors` | — |
| `multimedia` | `disable-image-generation` | `multimedia.disable-image-generation` | `disableImageGeneration` |
| `multimedia` | `gpt-image-2-base-model` | `multimedia.gpt-image-2-base-model` | `gptImage2BaseModel` |
| `multimedia` | `video-result-auth-cache-ttl` | `multimedia.video-result-auth-cache-ttl` | — |
| `observability` | `debug` | `observability.logs.debug` | `debug` |
| `observability` | `error-logs-max-files` | `observability.logs.error-logs-max-files` | `errorLogsMaxFiles` |
| `observability` | `logging-to-file` | `observability.logs.logging-to-file` | `loggingToFile` |
| `observability` | `logs-max-total-size-mb` | `observability.logs.logs-max-total-size-mb` | `logsMaxTotalSizeMb` |
| `observability` | `request-log` | `observability.logs.request-log` | `requestLog` |
| `observability` | `pprof.addr` | `observability.pprof.addr` | — |
| `observability` | `pprof.enable` | `observability.pprof.enable` | — |
| `observability` | `redis-usage-queue-retention-seconds` | `observability.usage.redis-usage-queue-retention-seconds` | `redisUsageQueueRetentionSeconds` |
| `observability` | `usage-statistics-enabled` | `observability.usage.usage-statistics-enabled` | `usageStatisticsEnabled` |

### Sections

Whole legacy sections that move; they place section-level editors (the payload rule
builder) and paths below a leaf.

| Legacy section | v8 section |
| --- | --- |
| `antigravity` | `oauth.providers.antigravity` |
| `antigravity.connection-pool` | `oauth.providers.antigravity.connection-pool` |
| `claude` | `oauth.providers.claude` |
| `claude-code` | `oauth.providers.claude.claude-code` |
| `claude-header-defaults` | `oauth.providers.claude.header-defaults` |
| `codex` | `oauth.providers.codex` |
| `codex-header-defaults` | `oauth.providers.codex.header-defaults` |
| `codex.live-media-relay` | `oauth.providers.codex.live-media-relay` |
| `credential-concurrency` | `credentials.concurrency` |
| `credential-in-flight` | `credentials.in-flight` |
| `devin` | `oauth.providers.devin` |
| `discovery` | `server.discovery` |
| `discovery.interfaces` | `server.discovery.interfaces` |
| `payload` | `requests.payload` |
| `pprof` | `observability.pprof` |
| `remote-management` | `management` |
| `streaming` | `requests.streaming` |
| `tls` | `server.tls` |
| `xai` | `oauth.providers.xai` |

### Upstream credential lists

These move under the root `api-keys` mapping **and change shape**, so no path rewrite
translates them. OMC edits them only through the v0 per-family endpoints, which CPA
translates in both directions (measured, §1).

| Legacy list | v8 location |
| --- | --- |
| `gemini-api-key` | `api-keys.gemini` |
| `interactions-api-key` | `api-keys.interactions` |
| `vertex-api-key` | `api-keys.vertex` |
| `codex-api-key` | `api-keys.codex` |
| `claude-api-key` | `api-keys.claude` |
| `xai-api-key` | `api-keys.xai` |
| `meta-api-key` | `api-keys.meta` |
| `openai-compatibility` | `api-keys.openai-compatibility` |

### Unchanged in v8

`routing.strategy`, `routing.session-affinity`, `routing.session-affinity-ttl`,
`routing.session-affinity-subagents`, `plugins.*`, `quota-exceeded.switch-project` and
`quota-exceeded.switch-preview-model` (the last two have no v8 counterpart at all).

## 4. OMC's write path on a v8 file: before and after

Measured with OMC's own save path: log in, `GET /management/config`, patch `safe_yaml`
with the configuration page's field logic (`web/src/components/config/configDirty.ts`),
`PUT /management/config/source`. The CPA file was the migrated v8 file from §1.

**Before this change** (OMC at `d201b28`): OMC answered `200 {"status":"ok"}`. Edits and
the resulting CPA values, read back from `GET /v0/management/config`:

| Field | Written at | Sent | CPA effective after save |
| --- | --- | --- | --- |
| request-retry | `request-retry` | 9 | 3 (unchanged) |
| proxy-url | `proxy-url` | `http://omc-proxy:3128` | `""` (unchanged) |
| disable-cooling | `disable-cooling` | true | false (unchanged) |
| passthrough-headers | `passthrough-headers` | true | false (unchanged) |
| commercial-mode | `commercial-mode` | true | false (unchanged) |

None of the five legacy keys remained in the file after the save. Writing the client-key
list the same way (root `api-keys` list over the provider groups, which is what the Keys
page did) is worse: measured directly against CPA, the client-key change was discarded
**and every upstream `codex` credential was deleted**.

**After this change**: the same edits are written at `routing.retry.request-retry`,
`requests.proxy-url`, `routing.cooldown.disable-cooling`,
`requests.passthrough-headers`, `server.commercial-mode`,
`observability.logs.debug` and `requests.nonstream-keepalive-interval`; all seven took
effect and no legacy key was written. A document with shadowed legacy keys is refused
before it reaches CPA (`422 config_legacy_keys_shadowed`, listing each `legacy → v8`
pair, file unchanged), and a root `api-keys` list over stored provider groups is refused
with `422 config_provider_groups_replaced`. The Keys page writes `access.api-keys` and
the upstream groups are untouched.

On a v7.3.20 gateway, the same edits through the previous and the new build produced a
**byte-identical** `config.yaml`. On a v8 gateway serving a legacy file, the new build
kept the legacy layout (no `config-version`, legacy keys edited in place, all effective).

## 5. Detection

Two independent facts, both observed rather than inferred from a version string:

- **Management API generation** (the capability bit): `GET
  /v8/management/config/config-version` must answer the value `8`. A 404/405/501 means
  v0 only. Any other status is not an answer and is not remembered. The body is checked,
  not just the status, so a catch-all proxy that answers 2xx cannot pass. The answer is
  cached per gateway base URL for five minutes (`API_SUPPORT_TTL`) and dropped whenever a
  v8 route answers "missing" (`internal/cpa/management/api_generation.go`). It is exposed
  as `layout.management_api` (`v8` / `v0` / `unknown`) on `GET /management/config`, and
  as capability key `management-v8` on `GET /management/capabilities/{key}`
  (`supported` / `missing`, the same contract as every other capability probe).
- **Configuration layout** of the stored file (`configyaml.DetectLayout`): `v8` when it
  has v8 sections (`config-version`, a v8-only root section, a root `api-keys` mapping,
  or `routing.retry` / `routing.cooldown` / `routing.force-model-prefix`) and no legacy
  spelling of a relocated setting; `legacy` when it has none of those; `mixed` when it
  has both. Exposed as `layout.layout` and `layout.has_provider_groups`.

## 6. Placement and the save guard

**Placement follows the document, not the gateway.** The configuration page and the
Keys page resolve every field through `web/src/components/config/configLayout.ts`:

- `legacy` document: legacy paths, on either gateway. A v7 gateway reads nothing else,
  and a v8 gateway reads a legacy file unchanged. OMC never performs a v8 configuration
  write, so it never triggers the migration.
- `v8` or `mixed` document: every relocated field is written at its v8 path. The legacy
  spelling is still read as a fallback while the v8 location is empty (CPA honours it
  then) and is removed whenever the field is written. Client keys are
  `access.api-keys`; the root `api-keys` mapping is never read as, or replaced by, a
  client-key list. Payload rules live at `requests.payload`, one category at a time.

**The save guard** (`checkConfigLayout` in `internal/api/management_config.go`) checks
every `PUT /management/config/source`, including hand edits in source mode, unless the
gateway is known to lack the v8 API. It refuses:

- a document in which a legacy spelling and its v8 twin are both present
  (`config_legacy_keys_shadowed`), because CPA v8 would answer success and drop the
  legacy value;
- a document that turns a stored root `api-keys` mapping into anything else
  (`config_provider_groups_replaced`), because that deletes every upstream credential.

An undecided probe is treated as v8 for the guard: a false refusal costs a message, a
missed one costs a silently lost setting. Both codes are shown in the console's language.

**Scalar writes** (`PUT /management/config/{key}`, also used by the Agent's `config_set`)
keep using the v0 flat setters. CPA places them itself (§1), so they need no mapping.

## 7. Read-side routes

Operations whose v8 route is registered on the same CPA handler as the v0 route are in
`OPERATION_ROUTES` (`internal/cpa/management/api_generation.go`). OMC calls the v8 route
when the gateway has the v8 API and falls back to v0 when a v8 route answers
404/405/501. The retry is safe because an unregistered route never reaches a handler.
A handler's own 404 (an unknown request id) is retried once on v0 and answers the same.

| Operation | v8 route | v0 route |
| --- | --- | --- |
| Usage queue (HTTP pull) | `/observability/usage/queue` | `/usage-queue` |
| API-key usage | `/observability/usage/api-keys` | `/api-key-usage` |
| Application logs (read, clear) | `/observability/logs` | `/logs` |
| Error-log list and download | `/observability/logs/errors[/<name>]` | `/request-error-logs[/<name>]` |
| Request log by id | `/observability/logs/requests/<id>` | `/request-log-by-id/<id>` |
| Authenticated upstream call (quota probes) | `/requests/api-call` | `/api-call` |
| Credential cooldown reset | `/routing/cooldown/reset` | `/reset-quota` |
| Latest release | `/server/latest-version` | `/latest-version` |

Everything else stays on v0, which v8 serves unchanged: configuration reads and writes,
the per-family credential lists, auth files, OAuth, plugins and the RESP usage channel.

## 8. Compatibility matrix

"Measured" means exercised against the real binary in this change; "unverified" means
not exercised end to end here.

| OMC surface | CPA v7.3.20 | CPA v8.0.2, legacy file | CPA v8.0.2, v8 file |
| --- | --- | --- | --- |
| Configuration page save | Measured, unchanged | Measured, stays legacy | Measured, v8 paths |
| Source editor save guard | Measured, not applied (v7) | Measured, passes | Measured, refuses both cases |
| Keys page | Measured, root `api-keys` | Unit-tested, root `api-keys` | Measured, `access.api-keys` |
| Scalar setters (v0) | Measured (11 keys) | Unverified | Measured (13 keys) |
| Provider credential lists (v0) | Measured read | Measured read | Measured read and write |
| Usage: RESP subscription | Measured | Measured | Layout-independent |
| Usage: HTTP queue, logs, error logs, API-key usage | Measured, v0 routes | Measured, v8 routes | Layout-independent |
| Request log, cooldown reset, api-call, latest version | Measured, v0 routes | Measured, v8 routes | Layout-independent |
| Capability probe `management-v8` | Measured `missing` | Measured `supported` | Layout-independent |
| OAuth login, auth files, plugins | Unverified in this change | Unverified | Unverified |

"Layout-independent" rows choose their route from the API generation alone, which does
not depend on the file.

The OAuth, auth-file and plugin rows use v0 routes that v8 keeps with the same handlers.
No real provider sign-in or upstream traffic was possible in the test environment, so
those flows and the contents of usage records were not exercised. For the table's
routed operations, the route and status were checked, not payload contents.

## 9. Risks

- **The relocation table is a snapshot of v8.0.2.** CPA derives it from its Config
  struct, so a release that adds or moves a setting changes it. A new relocated setting
  that OMC does not know is not placed by the editor, and the guard does not check it.
  Re-derive the table (§10) when moving the pinned version.
- **A v8 configuration write by anything else migrates the file.** CPAMC or a script
  using `/v8/management/config` rewrites the whole file (reformatted, unknown sections
  commented out). OMC then sees a `v8` layout on its next read and follows it, but
  formatting and unknown sections do not come back.
- **v0 setters can leave legacy keys in a v8 file** (§1). CPA honours them and the
  editor reads them as fallbacks; the next edit of that field moves it to the v8 path.
- **Plugin OAuth.** In v8, plugin-provided OAuth providers start only through
  `/v8/management/oauth/auth-url`. OMC's OAuth workspace uses the per-provider v0 routes
  for its built-in providers and does not offer plugin providers.
- **Probe cache.** An upgrade in place is noticed within `API_SUPPORT_TTL` (five
  minutes); a rollback is noticed on the first v8 route that answers "missing".

## 10. Re-deriving the table for a new CPA release

1. Check out the release in a CLIProxyAPI clone.
2. Add a temporary test in its `internal/config` package that prints `v8Paths`,
   `v8StructPaths` and `v8KeyFamilies` (the package-level values in `config_v8.go`),
   and run it with `go test ./internal/config -run <name> -v`.
3. Regenerate `internal/cpa/configyaml/layout_rules.go` from that output (sorted, with
   `LegacyKind: LegacyKindSequence` on the `api-keys` row), then run `go test
   ./internal/cpa/configyaml/ ./internal/api/` and `pnpm test:logic`. The frontend suite
   `scripts/test-config-layout.ts` reads the same file and fails when an editor field
   names a path CPA does not read.
4. Compare `server_management_v8.go` of the release with `OPERATION_ROUTES`, and update
   this document.

