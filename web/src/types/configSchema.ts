export type ConfigSectionId =
  | 'connectivity'
  | 'network'
  | 'logging'
  | 'quota'
  | 'streaming'
  | 'advanced'
  | 'payload';

export type ConfigFieldType =
  | 'switch'
  | 'string'
  | 'number'
  | 'select'
  | 'api_keys'
  | 'textarea'
  | 'json_editor';

export interface ConfigFieldOption {
  value: string;
  labelKey: string;
}

export interface ConfigFieldDefinition {
  id: string;
  sectionId: ConfigSectionId;
  labelKey: string;
  descKey: string;
  yamlPath: string[];
  type: ConfigFieldType;
  scalarEndpointKey?: string;
  defaultValue?: unknown;
  placeholderKey?: string;
  unitKey?: string;
  min?: number;
  max?: number;
  options?: ConfigFieldOption[];
  keywords?: string[];
}

export const CONFIG_SECTIONS: { id: ConfigSectionId; labelKey: string; icon: string; descKey: string }[] = [
  { id: 'connectivity', labelKey: 'cfg.sec_connectivity', icon: 'KeyOutlined', descKey: 'cfg.sec_connectivity_desc' },
  { id: 'network', labelKey: 'cfg.sec_network', icon: 'GlobalOutlined', descKey: 'cfg.sec_network_desc' },
  { id: 'logging', labelKey: 'cfg.sec_logging', icon: 'ProfileOutlined', descKey: 'cfg.sec_logging_desc' },
  { id: 'quota', labelKey: 'cfg.sec_quota', icon: 'FieldTimeOutlined', descKey: 'cfg.sec_quota_desc' },
  { id: 'streaming', labelKey: 'cfg.sec_streaming', icon: 'NodeIndexOutlined', descKey: 'cfg.sec_streaming_desc' },
  { id: 'advanced', labelKey: 'cfg.sec_advanced', icon: 'ExperimentOutlined', descKey: 'cfg.sec_advanced_desc' },
  { id: 'payload', labelKey: 'cfg.sec_payload', icon: 'CodeOutlined', descKey: 'cfg.sec_payload_desc' },
];

export interface ConfigGroupDefinition {
  id: string;
  sectionId: ConfigSectionId;
  labelKey: string;
  descKey?: string;
  variant: 'form-grid' | 'settings-list' | 'managed-elsewhere' | 'tls-accordion' | 'payload-builder';
  fieldIds: string[];
}

export const CONFIG_GROUPS: ConfigGroupDefinition[] = [
  // ── 1. Connectivity & auth ──────────────────────────────────────────
  {
    id: 'grp_service',
    sectionId: 'connectivity',
    labelKey: 'cfg.grp_service',
    descKey: 'cfg.grp_service_desc',
    variant: 'form-grid',
    fieldIds: ['host', 'port', 'authDir'],
  },
  {
    id: 'grp_apikeys',
    sectionId: 'connectivity',
    labelKey: 'cfg.grp_apikeys',
    descKey: 'cfg.grp_apikeys_desc',
    variant: 'managed-elsewhere',
    fieldIds: ['apiKeys'],
  },
  {
    id: 'grp_tls',
    sectionId: 'connectivity',
    labelKey: 'cfg.grp_tls',
    descKey: 'cfg.grp_tls_desc',
    variant: 'tls-accordion',
    fieldIds: ['tlsEnable', 'tlsCert', 'tlsKey'],
  },
  {
    id: 'grp_remote',
    sectionId: 'connectivity',
    labelKey: 'cfg.grp_remote',
    descKey: 'cfg.grp_remote_desc',
    variant: 'settings-list',
    fieldIds: ['rmAllowRemote', 'rmSecretKey', 'rmDisableControlPanel', 'rmDisableAutoUpdatePanel', 'rmPanelRepo'],
  },

  // ── 2. Network ────────────────────────────────────────────────
  {
    id: 'grp_proxy_retry',
    sectionId: 'network',
    labelKey: 'cfg.grp_proxy_retry',
    descKey: 'cfg.grp_proxy_retry_desc',
    variant: 'form-grid',
    fieldIds: ['proxyUrl', 'requestRetry', 'maxRetryCredentials', 'maxRetryInterval', 'authAutoRefreshWorkers'],
  },
  {
    id: 'grp_routing_affinity',
    sectionId: 'network',
    labelKey: 'cfg.grp_routing_affinity',
    descKey: 'cfg.grp_routing_affinity_desc',
    variant: 'form-grid',
    fieldIds: ['routingStrategy', 'routingSessionAffinityTTL', 'routingSessionAffinity'],
  },
  {
    id: 'grp_network_flags',
    sectionId: 'network',
    labelKey: 'cfg.grp_network_flags',
    descKey: 'cfg.grp_network_flags_desc',
    variant: 'settings-list',
    fieldIds: ['disableImageGeneration', 'gptImage2BaseModel', 'forceModelPrefix', 'passthroughHeaders', 'disableCooling', 'wsAuth'],
  },

  // ── 3. Logging & diagnostics ──────────────────────────────────────────────
  {
    id: 'grp_logging_mode',
    sectionId: 'logging',
    labelKey: 'cfg.grp_logging_mode',
    descKey: 'cfg.grp_logging_mode_desc',
    variant: 'settings-list',
    fieldIds: ['debug', 'commercialMode', 'requestLog', 'loggingToFile', 'usageStatisticsEnabled'],
  },
  {
    id: 'grp_logging_storage',
    sectionId: 'logging',
    labelKey: 'cfg.grp_logging_storage',
    descKey: 'cfg.grp_logging_storage_desc',
    variant: 'form-grid',
    fieldIds: ['logsMaxTotalSizeMb', 'errorLogsMaxFiles', 'redisUsageQueueRetentionSeconds'],
  },

  // ── 4. Quota fallback ──────────────────────────────────────────────────
  {
    id: 'grp_quota_strategy',
    sectionId: 'quota',
    labelKey: 'cfg.grp_quota_strategy',
    descKey: 'cfg.grp_quota_strategy_desc',
    variant: 'settings-list',
    fieldIds: ['quotaSwitchProject', 'quotaSwitchPreviewModel', 'quotaAntigravityCredits'],
  },

  // ── 5. Streaming ──────────────────────────────────────────────
  {
    id: 'grp_streaming_transport',
    sectionId: 'streaming',
    labelKey: 'cfg.grp_streaming_transport',
    descKey: 'cfg.grp_streaming_transport_desc',
    variant: 'form-grid',
    fieldIds: ['streamingKeepaliveSeconds', 'streamingBootstrapRetries', 'streamingNonstreamKeepalive'],
  },

  // ── 6. Advanced & experimental ────────────────────────────────────────────
  {
    id: 'grp_plugins',
    sectionId: 'advanced',
    labelKey: 'cfg.grp_plugins',
    descKey: 'cfg.grp_plugins_desc',
    variant: 'form-grid',
    fieldIds: ['pluginsEnabled', 'pluginStoreSources', 'pluginStoreAuth'],
  },
  {
    id: 'grp_signature_cache',
    sectionId: 'advanced',
    labelKey: 'cfg.grp_signature_cache',
    descKey: 'cfg.grp_signature_cache_desc',
    variant: 'settings-list',
    fieldIds: ['antigravitySignatureCacheEnabled', 'antigravitySignatureBypassStrict'],
  },
  {
    id: 'grp_claude_headers',
    sectionId: 'advanced',
    labelKey: 'cfg.grp_claude_headers',
    descKey: 'cfg.grp_claude_headers_desc',
    variant: 'form-grid',
    fieldIds: ['claudeHeaderUserAgent', 'claudeHeaderPackageVersion', 'claudeHeaderRuntimeVersion', 'claudeHeaderOs', 'claudeHeaderArch', 'claudeHeaderTimeout', 'claudeHeaderStabilizeDeviceProfile'],
  },
  {
    id: 'grp_codex_headers',
    sectionId: 'advanced',
    labelKey: 'cfg.grp_codex_headers',
    descKey: 'cfg.grp_codex_headers_desc',
    variant: 'form-grid',
    fieldIds: ['codexHeaderUserAgent', 'codexHeaderBetaFeatures'],
  },

  // ── 7. Payload rules ────────────────────────────────────────────
  {
    id: 'grp_payload_rules',
    sectionId: 'payload',
    labelKey: 'cfg.grp_payload_rules',
    descKey: 'cfg.grp_payload_rules_desc',
    variant: 'payload-builder',
    fieldIds: ['payloadDefaultRules', 'payloadDefaultRawRules', 'payloadOverrideRules', 'payloadOverrideRawRules', 'payloadFilterRules'],
  },
];

export function getGroupsForSection(sectionId: ConfigSectionId): ConfigGroupDefinition[] {
  const groups = CONFIG_GROUPS.filter((g) => g.sectionId === sectionId);
  const groupedFieldIds = new Set(groups.flatMap((g) => g.fieldIds));
  const remainingFields = ALL_CONFIG_FIELDS.filter(
    (f) => f.sectionId === sectionId && !groupedFieldIds.has(f.id),
  );
  if (remainingFields.length > 0) {
    groups.push({
      id: `${sectionId}_other`,
      sectionId,
      labelKey: 'cfg.grp_other',
      descKey: 'cfg.grp_other_desc',
      variant: 'form-grid',
      fieldIds: remainingFields.map((f) => f.id),
    });
  }
  return groups;
}

export const ALL_CONFIG_FIELDS: ConfigFieldDefinition[] = [
  // ── 1. Connectivity & auth ──────────────────────────────────────────
  {
    id: 'host',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_host',
    descKey: 'cfg.f_host_desc',
    yamlPath: ['host'],
    type: 'string',
    placeholderKey: '0.0.0.0',
    defaultValue: '127.0.0.1',
    keywords: ['host', 'ip', 'bind', 'server'],
  },
  {
    id: 'port',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_port',
    descKey: 'cfg.f_port_desc',
    yamlPath: ['port'],
    type: 'number',
    min: 1,
    max: 65535,
    defaultValue: 8317,
    keywords: ['port', 'listen'],
  },
  {
    id: 'authDir',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_auth_dir',
    descKey: 'cfg.f_auth_dir_desc',
    yamlPath: ['auth-dir'],
    type: 'string',
    placeholderKey: 'auth',
    defaultValue: 'auth',
    keywords: ['auth', 'dir', 'directory'],
  },
  {
    id: 'apiKeys',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_api_keys',
    descKey: 'cfg.f_api_keys_desc',
    yamlPath: ['api-keys'],
    type: 'api_keys',
    defaultValue: [],
    keywords: ['api-key', 'apikey', 'token', 'secret'],
  },
  {
    id: 'tlsEnable',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_tls_enable',
    descKey: 'cfg.f_tls_enable_desc',
    yamlPath: ['tls', 'enable'],
    type: 'switch',
    defaultValue: false,
    keywords: ['tls', 'ssl', 'https'],
  },
  {
    id: 'tlsCert',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_tls_cert',
    descKey: 'cfg.f_tls_cert_desc',
    yamlPath: ['tls', 'cert'],
    type: 'string',
    keywords: ['tls', 'cert', 'certificate'],
  },
  {
    id: 'tlsKey',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_tls_key',
    descKey: 'cfg.f_tls_key_desc',
    yamlPath: ['tls', 'key'],
    type: 'string',
    keywords: ['tls', 'key', 'private'],
  },
  {
    id: 'rmAllowRemote',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_rm_allow_remote',
    descKey: 'cfg.f_rm_allow_remote_desc',
    yamlPath: ['remote-management', 'allow-remote'],
    type: 'switch',
    defaultValue: false,
    keywords: ['remote', 'allow'],
  },
  {
    id: 'rmSecretKey',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_rm_secret_key',
    descKey: 'cfg.f_rm_secret_key_desc',
    yamlPath: ['remote-management', 'secret-key'],
    type: 'string',
    keywords: ['management', 'secret', 'password'],
  },
  {
    id: 'rmDisableControlPanel',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_rm_disable_panel',
    descKey: 'cfg.f_rm_disable_panel_desc',
    yamlPath: ['remote-management', 'disable-control-panel'],
    type: 'switch',
    defaultValue: false,
    keywords: ['panel', 'disable'],
  },
  {
    id: 'rmDisableAutoUpdatePanel',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_rm_disable_auto_update',
    descKey: 'cfg.f_rm_disable_auto_update_desc',
    yamlPath: ['remote-management', 'disable-auto-update-panel'],
    type: 'switch',
    defaultValue: false,
    keywords: ['update', 'auto'],
  },
  {
    id: 'rmPanelRepo',
    sectionId: 'connectivity',
    labelKey: 'cfg.f_rm_panel_repo',
    descKey: 'cfg.f_rm_panel_repo_desc',
    yamlPath: ['remote-management', 'panel-github-repository'],
    type: 'string',
    placeholderKey: 'router-for-me/Cli-Proxy-API-Management-Center',
    keywords: ['repo', 'github'],
  },

  // ── 2. Network ────────────────────────────────────────────────
  {
    id: 'proxyUrl',
    sectionId: 'network',
    labelKey: 'cfg.proxy_url',
    descKey: 'cfg.proxy_url_desc',
    yamlPath: ['proxy-url'],
    type: 'string',
    scalarEndpointKey: 'proxy_url',
    placeholderKey: 'cfg.proxy_url_placeholder',
    keywords: ['proxy', 'socks5', 'http'],
  },
  {
    id: 'requestRetry',
    sectionId: 'network',
    labelKey: 'cfg.request_retry',
    descKey: 'cfg.request_retry_desc',
    yamlPath: ['request-retry'],
    type: 'number',
    scalarEndpointKey: 'request_retry',
    min: 0,
    max: 20,
    unitKey: 'cfg.unit_times',
    defaultValue: 3,
    keywords: ['retry', 'request'],
  },
  {
    id: 'maxRetryCredentials',
    sectionId: 'network',
    labelKey: 'cfg.max_retry_credentials',
    descKey: 'cfg.max_retry_credentials_desc',
    yamlPath: ['max-retry-credentials'],
    type: 'number',
    scalarEndpointKey: 'max_retry_credentials',
    min: 0,
    unitKey: 'cfg.unit_files',
    defaultValue: 0,
    keywords: ['retry', 'credential'],
  },
  {
    id: 'maxRetryInterval',
    sectionId: 'network',
    labelKey: 'cfg.max_retry_interval',
    descKey: 'cfg.max_retry_interval_desc',
    yamlPath: ['max-retry-interval'],
    type: 'number',
    scalarEndpointKey: 'max_retry_interval',
    min: 0,
    unitKey: 'cfg.unit_seconds',
    defaultValue: 30,
    keywords: ['retry', 'interval'],
  },
  {
    id: 'authAutoRefreshWorkers',
    sectionId: 'network',
    labelKey: 'cfg.f_auth_refresh_workers',
    descKey: 'cfg.f_auth_refresh_workers_desc',
    yamlPath: ['auth-auto-refresh-workers'],
    type: 'number',
    min: 0,
    unitKey: 'cfg.unit_files',
    defaultValue: 0,
    keywords: ['worker', 'refresh'],
  },
  {
    id: 'routingStrategy',
    sectionId: 'network',
    labelKey: 'cfg.routing_strategy',
    descKey: 'cfg.routing_strategy_desc',
    yamlPath: ['routing', 'strategy'],
    type: 'select',
    scalarEndpointKey: 'routing_strategy',
    defaultValue: 'round-robin',
    options: [
      { value: 'round-robin', labelKey: 'cfg.strategy_round_robin' },
      { value: 'least-load', labelKey: 'cfg.strategy_least_load' },
      { value: 'weighted-round-robin', labelKey: 'cfg.strategy_wrr' },
      { value: 'fill-first', labelKey: 'cfg.strategy_fill_first' },
    ],
    keywords: ['routing', 'strategy', 'balance', 'load'],
  },
  {
    id: 'routingSessionAffinityTTL',
    sectionId: 'network',
    labelKey: 'cfg.f_affinity_ttl',
    descKey: 'cfg.f_affinity_ttl_desc',
    yamlPath: ['routing', 'session-affinity-ttl'],
    type: 'string',
    placeholderKey: '1h',
    keywords: ['affinity', 'session', 'ttl'],
  },
  {
    id: 'routingSessionAffinity',
    sectionId: 'network',
    labelKey: 'cfg.f_affinity',
    descKey: 'cfg.f_affinity_desc',
    yamlPath: ['routing', 'session-affinity'],
    type: 'switch',
    defaultValue: false,
    keywords: ['affinity', 'session'],
  },
  {
    id: 'disableImageGeneration',
    sectionId: 'network',
    labelKey: 'cfg.f_disable_image_gen',
    descKey: 'cfg.f_disable_image_gen_desc',
    yamlPath: ['disable-image-generation'],
    type: 'switch',
    defaultValue: false,
    keywords: ['image', 'dall-e'],
  },
  {
    id: 'gptImage2BaseModel',
    sectionId: 'network',
    labelKey: 'cfg.f_gpt_image_model',
    descKey: 'cfg.f_gpt_image_model_desc',
    yamlPath: ['gpt-image-2-base-model'],
    type: 'string',
    keywords: ['image', 'base64', 'model'],
  },
  {
    id: 'forceModelPrefix',
    sectionId: 'network',
    labelKey: 'cfg.force_model_prefix',
    descKey: 'cfg.force_model_prefix_desc',
    yamlPath: ['force-model-prefix'],
    type: 'switch',
    scalarEndpointKey: 'force_model_prefix',
    defaultValue: false,
    keywords: ['model', 'prefix'],
  },
  {
    id: 'passthroughHeaders',
    sectionId: 'network',
    labelKey: 'cfg.f_passthrough_headers',
    descKey: 'cfg.f_passthrough_headers_desc',
    yamlPath: ['passthrough-headers'],
    type: 'switch',
    defaultValue: false,
    keywords: ['header', 'passthrough'],
  },
  {
    id: 'disableCooling',
    sectionId: 'network',
    labelKey: 'cfg.f_disable_cooling',
    descKey: 'cfg.f_disable_cooling_desc',
    yamlPath: ['disable-cooling'],
    type: 'switch',
    defaultValue: false,
    keywords: ['cooling', 'cooldown'],
  },
  {
    id: 'wsAuth',
    sectionId: 'network',
    labelKey: 'cfg.ws_auth',
    descKey: 'cfg.ws_auth_desc',
    yamlPath: ['ws-auth'],
    type: 'switch',
    scalarEndpointKey: 'ws_auth',
    defaultValue: true,
    keywords: ['ws', 'websocket', 'auth'],
  },

  // ── 3. Logging & diagnostics ──────────────────────────────────────────────
  {
    id: 'debug',
    sectionId: 'logging',
    labelKey: 'cfg.debug',
    descKey: 'cfg.debug_desc',
    yamlPath: ['debug'],
    type: 'switch',
    scalarEndpointKey: 'debug',
    defaultValue: false,
    keywords: ['debug', 'log', 'verbose'],
  },
  {
    id: 'commercialMode',
    sectionId: 'logging',
    labelKey: 'cfg.f_commercial_mode',
    descKey: 'cfg.f_commercial_mode_desc',
    yamlPath: ['commercial-mode'],
    type: 'switch',
    defaultValue: false,
    keywords: ['commercial', 'mode'],
  },
  {
    id: 'requestLog',
    sectionId: 'logging',
    labelKey: 'cfg.request_log',
    descKey: 'cfg.request_log_desc',
    yamlPath: ['request-log'],
    type: 'switch',
    scalarEndpointKey: 'request_log',
    defaultValue: false,
    keywords: ['request', 'log'],
  },
  {
    id: 'loggingToFile',
    sectionId: 'logging',
    labelKey: 'cfg.logging_to_file',
    descKey: 'cfg.logging_to_file_desc',
    yamlPath: ['logging-to-file'],
    type: 'switch',
    scalarEndpointKey: 'logging_to_file',
    defaultValue: false,
    keywords: ['file', 'log', 'tail'],
  },
  {
    id: 'logsMaxTotalSizeMb',
    sectionId: 'logging',
    labelKey: 'cfg.logs_max_total_size_mb',
    descKey: 'cfg.logs_max_total_size_mb_desc',
    yamlPath: ['logs-max-total-size-mb'],
    type: 'number',
    scalarEndpointKey: 'logs_max_total_size_mb',
    min: 0,
    unitKey: 'cfg.unit_mb',
    defaultValue: 0,
    keywords: ['size', 'mb', 'log'],
  },
  {
    id: 'errorLogsMaxFiles',
    sectionId: 'logging',
    labelKey: 'cfg.error_logs_max_files',
    descKey: 'cfg.error_logs_max_files_desc',
    yamlPath: ['error-logs-max-files'],
    type: 'number',
    scalarEndpointKey: 'error_logs_max_files',
    min: 0,
    unitKey: 'cfg.unit_files',
    defaultValue: 10,
    keywords: ['error', 'file', 'log'],
  },
  {
    id: 'redisUsageQueueRetentionSeconds',
    sectionId: 'logging',
    labelKey: 'cfg.f_redis_retention',
    descKey: 'cfg.f_redis_retention_desc',
    yamlPath: ['redis-usage-queue-retention-seconds'],
    type: 'number',
    min: 0,
    unitKey: 'cfg.unit_seconds',
    defaultValue: 60,
    keywords: ['redis', 'queue', 'retention'],
  },
  {
    id: 'usageStatisticsEnabled',
    sectionId: 'logging',
    labelKey: 'cfg.usage_statistics_enabled',
    descKey: 'cfg.usage_statistics_enabled_desc',
    yamlPath: ['usage-statistics-enabled'],
    type: 'switch',
    scalarEndpointKey: 'usage_statistics_enabled',
    defaultValue: true,
    keywords: ['usage', 'stats', 'token'],
  },

  // ── 4. Quota fallback ──────────────────────────────────────────────────
  {
    id: 'quotaSwitchProject',
    sectionId: 'quota',
    labelKey: 'cfg.f_switch_project',
    descKey: 'cfg.f_switch_project_desc',
    yamlPath: ['quota-exceeded', 'switch-project'],
    type: 'switch',
    defaultValue: true,
    keywords: ['quota', 'project', 'switch'],
  },
  {
    id: 'quotaSwitchPreviewModel',
    sectionId: 'quota',
    labelKey: 'cfg.f_switch_preview_model',
    descKey: 'cfg.f_switch_preview_model_desc',
    yamlPath: ['quota-exceeded', 'switch-preview-model'],
    type: 'switch',
    defaultValue: true,
    keywords: ['quota', 'preview', 'model'],
  },
  {
    id: 'quotaAntigravityCredits',
    sectionId: 'quota',
    labelKey: 'cfg.f_antigravity_credits',
    descKey: 'cfg.f_antigravity_credits_desc',
    yamlPath: ['quota-exceeded', 'antigravity-credits'],
    type: 'switch',
    defaultValue: true,
    keywords: ['antigravity', 'credits'],
  },

  // ── 5. Streaming ──────────────────────────────────────────
  {
    id: 'streamingKeepaliveSeconds',
    sectionId: 'streaming',
    labelKey: 'cfg.f_keepalive_sec',
    descKey: 'cfg.f_keepalive_sec_desc',
    yamlPath: ['streaming', 'keepalive-seconds'],
    type: 'number',
    min: 0,
    unitKey: 'cfg.unit_seconds',
    defaultValue: 0,
    keywords: ['stream', 'keepalive', 'sse'],
  },
  {
    id: 'streamingBootstrapRetries',
    sectionId: 'streaming',
    labelKey: 'cfg.f_bootstrap_retries',
    descKey: 'cfg.f_bootstrap_retries_desc',
    yamlPath: ['streaming', 'bootstrap-retries'],
    type: 'number',
    min: 0,
    unitKey: 'cfg.unit_times',
    defaultValue: 0,
    keywords: ['stream', 'bootstrap', 'retry'],
  },
  {
    id: 'streamingNonstreamKeepalive',
    sectionId: 'streaming',
    labelKey: 'cfg.f_nonstream_keepalive',
    descKey: 'cfg.f_nonstream_keepalive_desc',
    yamlPath: ['streaming', 'nonstream-keepalive-interval'],
    type: 'string',
    placeholderKey: '0s',
    keywords: ['stream', 'nonstream', 'keepalive'],
  },

  // ── 6. Advanced & experimental ────────────────────────────────────────────
  {
    id: 'pluginsEnabled',
    sectionId: 'advanced',
    labelKey: 'cfg.f_plugins_enabled',
    descKey: 'cfg.f_plugins_enabled_desc',
    yamlPath: ['plugins', 'enabled'],
    type: 'switch',
    defaultValue: false,
    keywords: ['plugin', 'extension'],
  },
  {
    id: 'pluginStoreSources',
    sectionId: 'advanced',
    labelKey: 'cfg.f_plugin_store_sources',
    descKey: 'cfg.f_plugin_store_sources_desc',
    yamlPath: ['plugins', 'store-sources'],
    type: 'string',
    keywords: ['plugin', 'store', 'source'],
  },
  {
    id: 'pluginStoreAuth',
    sectionId: 'advanced',
    labelKey: 'cfg.f_plugin_store_auth',
    descKey: 'cfg.f_plugin_store_auth_desc',
    yamlPath: ['plugins', 'store-auth'],
    type: 'json_editor',
    keywords: ['plugin', 'auth'],
  },
  {
    id: 'antigravitySignatureCacheEnabled',
    sectionId: 'advanced',
    labelKey: 'cfg.f_sig_cache',
    descKey: 'cfg.f_sig_cache_desc',
    yamlPath: ['antigravity', 'signature-cache-enabled'],
    type: 'switch',
    defaultValue: false,
    keywords: ['signature', 'cache', 'antigravity'],
  },
  {
    id: 'antigravitySignatureBypassStrict',
    sectionId: 'advanced',
    labelKey: 'cfg.f_sig_strict',
    descKey: 'cfg.f_sig_strict_desc',
    yamlPath: ['antigravity', 'signature-bypass-strict'],
    type: 'switch',
    defaultValue: false,
    keywords: ['signature', 'strict', 'bypass'],
  },
  {
    id: 'claudeHeaderUserAgent',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_ua',
    descKey: 'cfg.f_claude_ua_desc',
    yamlPath: ['claude-header-defaults', 'user-agent'],
    type: 'string',
    keywords: ['claude', 'user-agent', 'header'],
  },
  {
    id: 'claudeHeaderPackageVersion',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_pkg',
    descKey: 'cfg.f_claude_pkg_desc',
    yamlPath: ['claude-header-defaults', 'package-version'],
    type: 'string',
    keywords: ['claude', 'version'],
  },
  {
    id: 'claudeHeaderRuntimeVersion',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_runtime',
    descKey: 'cfg.f_claude_runtime_desc',
    yamlPath: ['claude-header-defaults', 'runtime-version'],
    type: 'string',
    keywords: ['claude', 'runtime'],
  },
  {
    id: 'claudeHeaderOs',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_os',
    descKey: 'cfg.f_claude_os_desc',
    yamlPath: ['claude-header-defaults', 'os'],
    type: 'string',
    keywords: ['claude', 'os'],
  },
  {
    id: 'claudeHeaderArch',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_arch',
    descKey: 'cfg.f_claude_arch_desc',
    yamlPath: ['claude-header-defaults', 'arch'],
    type: 'string',
    keywords: ['claude', 'arch'],
  },
  {
    id: 'claudeHeaderTimeout',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_timeout',
    descKey: 'cfg.f_claude_timeout_desc',
    yamlPath: ['claude-header-defaults', 'timeout'],
    type: 'string',
    keywords: ['claude', 'timeout'],
  },
  {
    id: 'claudeHeaderStabilizeDeviceProfile',
    sectionId: 'advanced',
    labelKey: 'cfg.f_claude_stabilize',
    descKey: 'cfg.f_claude_stabilize_desc',
    yamlPath: ['claude-header-defaults', 'stabilize-device-profile'],
    type: 'switch',
    defaultValue: false,
    keywords: ['claude', 'device', 'fingerprint'],
  },
  {
    id: 'codexHeaderUserAgent',
    sectionId: 'advanced',
    labelKey: 'cfg.f_codex_ua',
    descKey: 'cfg.f_codex_ua_desc',
    yamlPath: ['codex-header-defaults', 'user-agent'],
    type: 'string',
    keywords: ['codex', 'user-agent'],
  },
  {
    id: 'codexHeaderBetaFeatures',
    sectionId: 'advanced',
    labelKey: 'cfg.f_codex_beta',
    descKey: 'cfg.f_codex_beta_desc',
    yamlPath: ['codex-header-defaults', 'beta-features'],
    type: 'string',
    keywords: ['codex', 'beta'],
  },

  // ── 7. Payload rules ────────────────────────────────────────────
  {
    id: 'payloadDefaultRules',
    sectionId: 'payload',
    labelKey: 'cfg.f_payload_default',
    descKey: 'cfg.f_payload_default_desc',
    yamlPath: ['payload', 'default'],
    type: 'json_editor',
    keywords: ['payload', 'default'],
  },
  {
    id: 'payloadDefaultRawRules',
    sectionId: 'payload',
    labelKey: 'cfg.f_payload_default_raw',
    descKey: 'cfg.f_payload_default_raw_desc',
    yamlPath: ['payload', 'default-raw'],
    type: 'json_editor',
    keywords: ['payload', 'raw', 'json'],
  },
  {
    id: 'payloadOverrideRules',
    sectionId: 'payload',
    labelKey: 'cfg.f_payload_override',
    descKey: 'cfg.f_payload_override_desc',
    yamlPath: ['payload', 'override'],
    type: 'json_editor',
    keywords: ['payload', 'override'],
  },
  {
    id: 'payloadOverrideRawRules',
    sectionId: 'payload',
    labelKey: 'cfg.f_payload_override_raw',
    descKey: 'cfg.f_payload_override_raw_desc',
    yamlPath: ['payload', 'override-raw'],
    type: 'json_editor',
    keywords: ['payload', 'override', 'raw'],
  },
  {
    id: 'payloadFilterRules',
    sectionId: 'payload',
    labelKey: 'cfg.f_payload_filter',
    descKey: 'cfg.f_payload_filter_desc',
    yamlPath: ['payload', 'filter'],
    type: 'json_editor',
    keywords: ['payload', 'filter'],
  },
];
