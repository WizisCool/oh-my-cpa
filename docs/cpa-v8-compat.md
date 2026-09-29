# CPA v8 compatibility

Oh My CPA (OMC) requires CLIProxyAPI (CPA) v8.0.0 or later and speaks its v8 Management
API (ADR 0034, which supersedes the one-build-for-v7-and-v8 decision of ADR 0028). This
document records what v8 changed, what was measured against real binaries, how OMC
decides that a gateway is v8, how it edits the configuration (ADR 0037), which routes it
calls, and what remains unverified. Measurements against v7.3.20 below are kept as the record of how v8
treats a v7 configuration file, which is what an upgraded deployment starts from.

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
  `GET /v0/management/config.yaml` returns the file as stored. OMC edits the former and
  reads the latter only to keep a legacy file before its first v8 write (§4).

### v8 configuration writes (measured)

Measured on the v8.0.2 binary with a management password set.

| Request | Result |
| --- | --- |
| `PATCH /v8/management/config` with a JSON merge document | Merged; keys it does not name are kept |
| `PUT /v8/management/config/<path>` | Replaces that path; the body is the raw JSON value (a `{"value": …}` envelope is refused) |
| `DELETE /v8/management/config/<path>` | Removes that path; a path that is not set answers `404 not_found` |
| A `null` in a merge | Writes the type's zero value, not a removal |
| A legacy field name (`debug`, in a merge or in `PUT /config.yaml`) | `400 invalid_config`, "legacy field debug is not accepted by v8; use observability.logs.debug"; nothing written |
| An unknown section | `400 invalid_config`, "unknown v8 configuration section …"; nothing written |
| A value of the wrong type | `422 invalid_config` naming the line and type; nothing written |
| A burst of sequential writes | Every value kept |
| `PATCH` with `{"api-keys": {"claude": [...]}}` | Replaces that family's groups; the other families are kept |
| A key that overrides a group setting (`models: []`, `priority: 0`, `excluded-models`, `disable-cooling: false`) | Accepted; the v0 runtime list shows the key's own value |
| `base-url` on a key | Refused: only a group may carry it |
| `GET /config/api-keys/<family>/0/keys` | `404 not_found`: list items are not addressable paths, so a family is written whole |
| `PUT /config/plugins/configs/<id>`, `PUT /config/plugins/configs/<id>/enabled` | Replace that plugin's settings, or only its switch |
| `PATCH` of `oauth.model-alias.<provider>`, `DELETE /config/oauth/model-alias/<provider>` | Replace or remove one provider's aliases |

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
| `quota-exceeded.switch-project`, `switch-preview-model` | Not relocated | They stay under `quota-exceeded` in both layouts. CPA leaves them out of its v8 template as compatibility-only, but `quota-exceeded` is an accepted v8 root, a v8 `PATCH` writes them and the runtime applies them |

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

This is CPA's own table (`config_v8.go` at v8.0.2), which it applies when it converts a
legacy file. OMC does not carry a copy: its editor schema (`web/src/types/configSchema.ts`)
names the v8 column. The last column names the editor field; a `—` means no editor field
edits that setting.

Every schema path was measured against the v8.0.2 binary (Go build of tag `v8.0.2`,
commit `4a2c818`, on 2026-09-29): each one was written with a `PATCH
/v8/management/config` carrying the field's own default, and then read back out of the
persisted `config.yaml`. All 36 paths the OAuth-provider, discovery and pprof fields
added were accepted with `200` and survived into the file. Survival is the load-bearing
half of that check, because CPA re-serialises the document from its parsed configuration:
a key it does not know is dropped on the way to disk. Measured on the same binary, a
mistyped sibling loses the whole request - `oauth.providers.codex.live-media-relay.enabledd`
is refused with `400 invalid_config` ("field oauth not found in type config.legacyConfig"),
as is a mistyped leaf under a section CPA does know - so the check can fail.

Three value ranges in the schema were measured the same way rather than assumed:
`redis-usage-queue-retention-seconds` is clamped to 3600 server-side (9999 is stored as
3600, so the editor caps it), `transient-error-cooldown-seconds` accepts `-1` (so the
floor is `-1`, not `0`), and `request-retry` has no upper bound in CPA (50 is stored
unchanged, so the editor sets no maximum).

### Settings (leaves)

A leaf is the unit of CPA's precedence rule. "OMC editor field" names the configuration
page field that edits it.

| v8 section | Legacy path | v8 path | OMC editor field |
| --- | --- | --- | --- |
| `server` | `commercial-mode` | `server.commercial-mode` | `commercialMode` |
| `server` | `discovery.advertise-management` | `server.discovery.advertise-management` | `discoveryAdvertiseManagement` |
| `server` | `discovery.auth-required` | `server.discovery.auth-required` | `discoveryAuthRequired` |
| `server` | `discovery.enabled` | `server.discovery.enabled` | `discoveryEnabled` |
| `server` | `discovery.interfaces.exclude` | `server.discovery.interfaces.exclude` | — |
| `server` | `discovery.interfaces.include` | `server.discovery.interfaces.include` | — |
| `server` | `discovery.service-name` | `server.discovery.service-name` | `discoveryServiceName` |
| `server` | `discovery.service-type` | `server.discovery.service-type` | — |
| `server` | `discovery.subtypes` | `server.discovery.subtypes` | — |
| `server` | `host` | `server.host` | `host` |
| `server` | `port` | `server.port` | `port` |
| `server` | `tls.cert` | `server.tls.cert` | `tlsCert` |
| `server` | `tls.enable` | `server.tls.enable` | `tlsEnable` |
| `server` | `tls.key` | `server.tls.key` | `tlsKey` |
| `server` | `trusted-proxies` | `server.trusted-proxies` | `trustedProxies` |
| `management` | `remote-management.allow-remote` | `management.allow-remote` | `rmAllowRemote` |
| `management` | `remote-management.base-url` | `management.base-url` | `rmBaseUrl` |
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
| `routing` | `save-cooldown-status` | `routing.cooldown.save-cooldown-status` | `saveCooldownStatus` |
| `routing` | `transient-error-cooldown-seconds` | `routing.cooldown.transient-error-cooldown-seconds` | `transientErrorCooldownSeconds` |
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
| `oauth` | `antigravity.connection-pool.enabled` | `oauth.providers.antigravity.connection-pool.enabled` | `antigravityPoolEnabled` |
| `oauth` | `antigravity.connection-pool.idle-conn-timeout` | `oauth.providers.antigravity.connection-pool.idle-conn-timeout` | `antigravityPoolIdleConnTimeout` |
| `oauth` | `antigravity.connection-pool.max-idle-conns-per-host` | `oauth.providers.antigravity.connection-pool.max-idle-conns-per-host` | `antigravityPoolMaxIdleConnsPerHost` |
| `oauth` | `antigravity.sensitive-words` | `oauth.providers.antigravity.sensitive-words` | `antigravitySensitiveWords` |
| `oauth` | `antigravity-signature-bypass-strict` | `oauth.providers.antigravity.signature-bypass-strict` | `antigravitySignatureBypassStrict` |
| `oauth` | `antigravity-signature-cache-enabled` | `oauth.providers.antigravity.signature-cache-enabled` | `antigravitySignatureCacheEnabled` |
| `oauth` | `claude-code.disable-cloaking-model-list` | `oauth.providers.claude.claude-code.disable-cloaking-model-list` | `claudeDisableCloakingModelList` |
| `oauth` | `disable-claude-cloak-mode` | `oauth.providers.claude.disable-claude-cloak-mode` | `claudeDisableCloakMode` |
| `oauth` | `claude-header-defaults.arch` | `oauth.providers.claude.header-defaults.arch` | `claudeHeaderArch` |
| `oauth` | `claude-header-defaults.os` | `oauth.providers.claude.header-defaults.os` | `claudeHeaderOs` |
| `oauth` | `claude-header-defaults.package-version` | `oauth.providers.claude.header-defaults.package-version` | `claudeHeaderPackageVersion` |
| `oauth` | `claude-header-defaults.runtime-version` | `oauth.providers.claude.header-defaults.runtime-version` | `claudeHeaderRuntimeVersion` |
| `oauth` | `claude-header-defaults.stabilize-device-profile` | `oauth.providers.claude.header-defaults.stabilize-device-profile` | `claudeHeaderStabilizeDeviceProfile` |
| `oauth` | `claude-header-defaults.timeout` | `oauth.providers.claude.header-defaults.timeout` | `claudeHeaderTimeout` |
| `oauth` | `claude-header-defaults.timezone` | `oauth.providers.claude.header-defaults.timezone` | `claudeHeaderTimezone` |
| `oauth` | `claude-header-defaults.user-agent` | `oauth.providers.claude.header-defaults.user-agent` | `claudeHeaderUserAgent` |
| `oauth` | `claude.model-level-cooling` | `oauth.providers.claude.model-level-cooling` | `claudeModelLevelCooling` |
| `oauth` | `codex.disable-codex-cloaking` | `oauth.providers.codex.disable-codex-cloaking` | `codexDisableCloaking` |
| `oauth` | `codex-header-defaults.beta-features` | `oauth.providers.codex.header-defaults.beta-features` | `codexHeaderBetaFeatures` |
| `oauth` | `codex-header-defaults.user-agent` | `oauth.providers.codex.header-defaults.user-agent` | `codexHeaderUserAgent` |
| `oauth` | `codex.identity-confuse` | `oauth.providers.codex.identity-confuse` | `codexIdentityConfuse` |
| `oauth` | `codex.live-media-relay.disable-private-remote-ips` | `oauth.providers.codex.live-media-relay.disable-private-remote-ips` | `codexLiveDisablePrivateRemoteIps` |
| `oauth` | `codex.live-media-relay.enabled` | `oauth.providers.codex.live-media-relay.enabled` | `codexLiveEnabled` |
| `oauth` | `codex.live-media-relay.ice-servers` | `oauth.providers.codex.live-media-relay.ice-servers` | — |
| `oauth` | `codex.live-media-relay.max-sessions` | `oauth.providers.codex.live-media-relay.max-sessions` | `codexLiveMaxSessions` |
| `oauth` | `codex.live-media-relay.public-ip` | `oauth.providers.codex.live-media-relay.public-ip` | `codexLivePublicIp` |
| `oauth` | `codex.live-media-relay.udp-port-max` | `oauth.providers.codex.live-media-relay.udp-port-max` | `codexLiveUdpPortMax` |
| `oauth` | `codex.live-media-relay.udp-port-min` | `oauth.providers.codex.live-media-relay.udp-port-min` | `codexLiveUdpPortMin` |
| `oauth` | `codex.model-level-cooling` | `oauth.providers.codex.model-level-cooling` | `codexModelLevelCooling` |
| `oauth` | `codex.optimize-multi-agent-v2` | `oauth.providers.codex.optimize-multi-agent-v2` | `codexOptimizeMultiAgentV2` |
| `oauth` | `codex.orphan-delegation-compatibility` | `oauth.providers.codex.orphan-delegation-compatibility` | `codexOrphanDelegationCompatibility` |
| `oauth` | `codex.response-steering` | `oauth.providers.codex.response-steering` | `codexResponseSteering` |
| `oauth` | `codex.stream-bootstrap-buffering` | `oauth.providers.codex.stream-bootstrap-buffering` | `codexStreamBootstrapBuffering` |
| `oauth` | `codex.stream-bootstrap-timeout` | `oauth.providers.codex.stream-bootstrap-timeout` | `codexStreamBootstrapTimeout` |
| `oauth` | `devin.sensitive-words` | `oauth.providers.devin.sensitive-words` | `devinSensitiveWords` |
| `oauth` | `xai.inject-x-search` | `oauth.providers.xai.inject-x-search` | `xaiInjectXSearch` |
| `oauth` | `oauth-request-scoped-errors` | `oauth.request-scoped-errors` | — |
| `multimedia` | `disable-image-generation` | `multimedia.disable-image-generation` | `disableImageGeneration` |
| `multimedia` | `gpt-image-2-base-model` | `multimedia.gpt-image-2-base-model` | `gptImage2BaseModel` |
| `multimedia` | `video-result-auth-cache-ttl` | `multimedia.video-result-auth-cache-ttl` | `videoResultAuthCacheTTL` |
| `observability` | `debug` | `observability.logs.debug` | `debug` |
| `observability` | `error-logs-max-files` | `observability.logs.error-logs-max-files` | `errorLogsMaxFiles` |
| `observability` | `logging-to-file` | `observability.logs.logging-to-file` | `loggingToFile` |
| `observability` | `logs-max-total-size-mb` | `observability.logs.logs-max-total-size-mb` | `logsMaxTotalSizeMb` |
| `observability` | `request-log` | `observability.logs.request-log` | `requestLog` |
| `observability` | `pprof.addr` | `observability.pprof.addr` | `pprofAddr` |
| `observability` | `pprof.enable` | `observability.pprof.enable` | `pprofEnable` |
| `observability` | `redis-usage-queue-retention-seconds` | `observability.usage.redis-usage-queue-retention-seconds` | `redisUsageQueueRetentionSeconds` |
| `observability` | `usage-statistics-enabled` | `observability.usage.usage-statistics-enabled` | `usageStatisticsEnabled` |

### Sections

Whole legacy sections that move, with everything below them (the payload rule builder
edits `requests.payload`).

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

These move under the root `api-keys` mapping **and change shape**: each family is a list
of groups (`name`, `base-url`, shared settings, `keys`), and CPA's runtime view, the v0
per-family list, is those groups flattened one entry per key. OMC edits the flattened
list and writes the family back as groups, keeping the operator's grouping (ADR 0038,
§4). The masked configuration view hides every `api-key` value in them.

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
`quota-exceeded.switch-preview-model` (the last two are absent from CPA's v8 template but
are written and applied at the same path). All four `routing.*` entries here are edited by
the settings page (`routingStrategy`, `routingSessionAffinity`,
`routingSessionAffinityTTL`, `routingSessionAffinitySubagents`).

## 4. OMC's configuration write path

ADR 0037. Measured end to end on 2026-09-29: OMC built from this change, CPA v8.0.2,
and a legacy file with a top comment, client keys, one `codex-api-key` entry, payload
rules and an unknown `omc-operator-notes` section.

| Step | Result |
| --- | --- |
| `GET /management/config` on the legacy file | `stored_layout: legacy`; `safe_yaml` is CPA's v8 rendering (client keys at `access.api-keys`, the codex entry as an `api-keys.codex` group with its `api-key` masked, the unknown section as a comment); the file is byte-identical afterwards |
| `PATCH /management/config` with three changes (`observability.logs.debug`, `routing.retry.request-retry`, `access.api-keys`) | `200` with the new revision and rendering. One backup was kept first and is byte-identical to the original file; CPA converted the file (`config-version: 8`, four-space indentation, defaults added, the unknown section commented out) and all three values took effect; the upstream codex key was kept |
| The same save with a stale revision | `409 config_conflict`, nothing written |
| A change set whose merge carries a mistyped value | `422 config_rejected` with CPA's reason; nothing written, including the set's removal |
| A removal on the converted file | `200`; the key is gone and CPA reads its default |
| A later save on the converted file | No second backup |
| `PUT /management/config/source` with a legacy name | `422 config_rejected`: "legacy field debug is not accepted by v8; use observability.logs.debug"; file unchanged |

A change set is sent as one merge for scalars and lists, one `PUT` per map value and one
`DELETE` per removal, in that order (`Client.ApplyConfigChanges`). It is not atomic
across those requests (§9).

Provider, OAuth alias and plugin writes use the same change sets (ADR 0038). Measured end
to end on 2026-09-29 with a legacy file holding two `claude-api-key` entries (one with
`request-retry: 0`), an OpenAI-compatible provider with `support-prompt-cache-key` and a
model's `input-modalities`, an OAuth alias and a plugin's settings:

| Step | Result |
| --- | --- |
| Disable the second Claude key | One backup, then the file converted; the key is `api-keys.claude[1]` with `excluded-models: ["*"]` on the key and its group's `request-retry: 0` kept |
| With the family regrouped by hand (`team`: two keys sharing base URL, priority and models; `solo`), disable `team`'s second key | `team` kept; the exclusion is on that key only |
| Change the first key's base URL | That key becomes `team-2`, ahead of `team`; list order and every other `auth-index` unchanged |
| Create a provider | Appended as its own group |
| Delete a provider | Its key is removed from its group; the other groups unchanged |
| Disable the OpenAI-compatible provider | `disabled: true`; `support-prompt-cache-key`, `input-modalities` and its key kept, no `auth-index` in the file |
| Replace, add and empty OAuth aliases | `oauth.model-alias.codex` replaced; `claude` added then removed |
| Enable a plugin, then replace its settings | `plugins.configs.foo.enabled`, then the whole object; an unknown plugin reads as `plugin_not_found` |
| Every write after the first | No second backup |

## 5. Detection

Two independent facts, both observed rather than inferred from a version string:

- **Management API generation** (the gate): `GET /v8/management/config/config-version`
  must answer the value `8`. A 2xx with any other body means the gateway is older than
  v8; the body is checked so a catch-all proxy cannot pass. A 404/405/501 means the same
  unless `GET /v0/management/debug` is missing too: CPA answers 404 on every management
  path while it has no management secret, so that gateway is reported as `disabled`
  rather than old. Any other status is not an answer and is not remembered; the gate then
  lets requests through without probing again for fifteen seconds (`API_UNDECIDED_TTL`),
  while `/api/healthz` keeps re-asking. A v8 answer is cached per gateway
  base URL for five minutes (`API_SUPPORT_TTL`), a "not v8" answer for fifteen seconds
  (`API_UNSUPPORTED_TTL`, so an upgrade lifts the block quickly), and the cache is dropped
  whenever a v8 route answers "missing" (`internal/cpa/management/v8_gate.go`). Against a
  gateway that answered "not v8", every client operation returns
  `ErrManagementV8Required` without sending a request; the API layer reports it as
  `cpa_v8_required`, `/api/healthz` reports `cpa_management_api: unsupported`, and the
  console shows upgrade guidance in place of every page. Against a `disabled` gateway it
  returns `ErrManagementDisabled` (`cpa_management_disabled`), and the console shows the
  management-secret setting instead. An undecided probe blocks nothing.
- **Stored file layout** (`configyaml.IsV8Document` over `GET /v0/management/config.yaml`):
  `v8` when the file carries `config-version: 8` or later, `legacy` otherwise. It decides
  only whether the next configuration write keeps a backup first, and is exposed as
  `stored_layout`. It is read again before every configuration write.

## 6. Where a setting is written

Every editor names the v8 path, whatever the stored layout: CPA renders any file in the
v8 layout, and a v8 write to a legacy file converts it. Client keys are
`access.api-keys`; the root `api-keys` mapping is the upstream provider groups, written a
family at a time by the provider editor (`api-keys.<family>`). Payload rules are `requests.payload`, one category per
change.

There is no save guard of OMC's own. CPA refuses a legacy name, an unknown section or a
mistyped value without writing that request (§1). The console reports
`config_rejected` with CPA's reason if no earlier request in the change set landed, or
`config_partially_applied` if earlier requests were already written. Shadowed legacy
keys cannot arise from an editor that only writes v8 paths.

**Scalar writes** (`PUT /management/config/{key}`, also used by the Agent's `config_set`)
are one-change sets on the key's v8 path. OAuth model aliases are
`oauth.model-alias.<provider>`, per-plugin settings `plugins.configs.<id>` and their
switch `plugins.configs.<id>.enabled`.

## 7. Routes

Every operation is addressed at its `/v8/management` route, with no fallback:

| Operation | Route |
| --- | --- |
| Credential files: list, upload, delete, download, models, status, fields | `/credentials`, `/credentials/download`, `/credentials/models`, `/credentials/status`, `/credentials/fields` |
| OAuth login, status, cancellation, callback | `/oauth/auth-url?provider=`, `/oauth/status`, `/oauth/session`, `/oauth/callback` |
| Plugins: list, delete, store, install | `/plugins`, `/plugins/<id>`, `/plugins/store`, `/plugins/store/<id>/install` |
| Usage queue (HTTP pull) | `/observability/usage/queue` |
| API-key usage | `/observability/usage/api-keys` |
| Application logs (read, clear) | `/observability/logs` |
| Error-log list and download | `/observability/logs/errors[/<name>]` |
| Request log by id | `/observability/logs/requests/<id>` |
| Authenticated upstream call (quota probes) | `/requests/api-call` |
| Credential cooldown reset | `/routing/cooldown/reset` |
| Latest release | `/server/latest-version` |

The shared login endpoint names Claude `claude`, while the console and CPA's credential
files call it `anthropic`; `OAuthProvider.LoginProvider` carries the difference. Plugin
login providers are served by the same endpoint.

`/v0/management`, which v8 serves unchanged, is addressed only through
`internal/cpa/management/client_v0.go`, and only to read:

- the per-family credential lists (`/<family>-api-key`, `/openai-compatibility`), which
  are the only source of each upstream key's `auth-index`: the v8 configuration view is
  the stored document and carries no runtime fields;
- `/config.yaml`, the file as stored, read before a v8 write to keep a legacy file.

The RESP usage channel is not part of the Management API and is unchanged.

## 8. Compatibility matrix

"Measured" means exercised against the real binary; "unverified" means not exercised end
to end. The v7.3.20 column is the record from ADR 0028's change and no longer describes a
supported gateway: OMC now refuses v7 before any request.

| OMC surface | CPA v8.0.2, legacy file | CPA v8.0.2, v8 file |
| --- | --- | --- |
| Configuration page save (change set) | Measured: backup, then CPA converts the file | Measured, per-path writes |
| Source editor save | Refused by CPA on a legacy name (measured) | Measured |
| Keys page | Measured, `access.api-keys` (converts the file, as any save) | Measured, `access.api-keys` |
| Editor schema paths | — | Measured: all 36 newly added paths, each written with its field's default and read back from the persisted file |
| Scalar writes (`config_set`) | Unit-tested, one-change set | Unit-tested, one-change set |
| Provider credentials, OAuth aliases, plugin settings | Measured: backup, then converted by the first write | Measured, group-preserving writes |
| Usage: RESP subscription | Measured | Layout-independent |
| Usage: HTTP queue, logs, error logs, API-key usage | Measured, v8 routes | Layout-independent |
| Request log, cooldown reset, api-call, latest version | Measured, v8 routes | Layout-independent |
| Credential files, OAuth login, plugins (v8 routes) | Unit- and browser-tested against fixtures | Layout-independent |
| Gate against a v7 gateway | Unit-tested (every route of a v7 gateway answers 404) | — |

"Layout-independent" rows do not depend on the file.

The credential, OAuth and plugin routes are registered on the same CPA handlers as their
v0 counterparts (`server_management_v8.go`), which is why fixtures stand in for them. No
real provider sign-in or upstream traffic was possible in the test environment, so those
flows and the contents of usage records were not exercised against a real binary.

## 9. Risks

- **The editor schema names one release's paths.** A CPA release that moves or renames a
  setting makes CPA refuse the invalid request (`config_rejected` if no earlier
  request landed). Earlier valid requests in the same change set may already have been
  written; those saves return `config_partially_applied` without rolling them back.
  Re-check the schema (§10) when moving the pinned version.
- **The first save converts the file.** Formatting, comments of unmoved keys and unknown
  sections do not come back from CPA's conversion; the original is in the backup until
  ten later conversions have pushed it out. Any other v8 configuration writer (CPAMC, a
  script) converts the file the same way, without OMC's backup.
- **A change set is not atomic.** The merge goes first and is where CPA refuses a
  mistyped value; a map value or removal that fails after it leaves the merge applied.
  The save's answer re-reads CPA, so the editor shows what CPA holds.
- **A family is written whole.** CPA has no path for one key of a group, so a provider
  write sends the family's groups back. The provider write gate serialises OMC's own
  writes; a concurrent writer outside OMC editing the same family between the read and
  the write is overwritten, as with the v0 list writes before.
- **Probe cache.** An upgrade from v7 is noticed within `API_UNSUPPORTED_TTL` (fifteen
  seconds); a rollback to v7 is noticed on the first v8 route that answers "missing".

## 10. Checking a new CPA release

1. Run the release with a management password and a copy of a real configuration file.
2. For every field in `web/src/types/configSchema.ts`, send its current value (or a
   value of its type) to `PATCH /v8/management/config` at its `yamlPath`. A `400` names a
   path the release no longer accepts; move the field to the path the release's
   `config_v8.go` gives it, and add the row to §3.
3. Compare `server_management_v8.go` of the release with the routes in §7, and update
   this document.
