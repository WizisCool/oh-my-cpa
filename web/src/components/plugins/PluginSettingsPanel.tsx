import React from 'react';
import { Button, Card, Checkbox, Empty, Input, Select, Switch, Tooltip } from 'antd';
import { PageLoading } from '../common/PageLoading';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SafetyCertificateOutlined, SaveOutlined, UndoOutlined } from '../icons';
import { api, ApiError, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import type { PluginSettings, PluginStoreAuthRule, PluginStoreAuthTarget, PluginStoreAuthType } from '../../types/plugin';
import { pluginConfigsEqual } from './pluginConfig';
import {
  authRuleEnvFields,
  normalizePluginSettingsDraft,
  PLUGIN_STORE_AUTH_TARGETS,
  PLUGIN_STORE_AUTH_TYPES,
  validatePluginSettingsDraft,
  type PluginSettingsIssue,
} from './pluginStoreLogic';
import styles from './Plugins.module.css';
import { useToast } from '../feedback';
import { LoadFailure, Notice } from '../feedback';

interface SettingsDraft {
  enabled: boolean;
  sources: string[];
  rules: PluginStoreAuthRule[];
}

function draftFromSettings(settings: PluginSettings): SettingsDraft {
  return {
    enabled: settings.enabled,
    sources: [...settings.store_sources],
    rules: settings.store_auth.map((rule) => ({ ...rule, apply_to: [...rule.apply_to] })),
  };
}

function newRule(): PluginStoreAuthRule {
  return { match: '', apply_to: ['registry', 'metadata', 'artifact'], type: 'bearer', token_env: '', allow_insecure: false };
}

const ENV_PLACEHOLDERS: Record<'token_env' | 'username_env' | 'password_env' | 'header_value_env', string> = {
  token_env: 'CLIPROXY_PLUGIN_STORE_TOKEN',
  username_env: 'CLIPROXY_PLUGIN_STORE_USER',
  password_env: 'CLIPROXY_PLUGIN_STORE_PASSWORD',
  header_value_env: 'CLIPROXY_PLUGIN_STORE_HEADER_TOKEN',
};

interface PluginSettingsPanelProps {
  isDemo: boolean;
}

/**
 * The plugin system's host settings, which live in CPA's configuration file: the global
 * switch, the third-party registries the store reads, and the authentication rules for
 * registries and artifacts that need credentials.
 *
 * The save writes only these keys, against the revision the page loaded, so a change made
 * on the configuration page in the meantime is reported as a conflict rather than lost.
 */
export function PluginSettingsPanel({ isDemo }: PluginSettingsPanelProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['management-plugin-settings'],
    queryFn: api.getPluginSettings,
    staleTime: 15000,
  });

  const [draft, setDraft] = React.useState<SettingsDraft | null>(null);
  const [hasConflict, setHasConflict] = React.useState(false);
  const [showIssues, setShowIssues] = React.useState(false);
  const baseline = React.useMemo(() => (settingsQuery.data ? draftFromSettings(settingsQuery.data) : null), [settingsQuery.data]);

  // The draft exists only once something is edited, so a refetch moves the baseline
  // without ever replacing what the operator is typing.
  const isDirty = draft !== null && baseline !== null && (
    draft.enabled !== baseline.enabled
    || !pluginConfigsEqual(
      normalizePluginSettingsDraft(draft.sources, draft.rules),
      normalizePluginSettingsDraft(baseline.sources, baseline.rules),
    )
  );
  const current = draft ?? baseline;

  const issues = React.useMemo(
    () => (current ? validatePluginSettingsDraft(current.sources, current.rules) : []),
    [current],
  );

  const saveMutation = useMutation({
    mutationFn: (next: SettingsDraft) => {
      const { storeSources, storeAuth } = normalizePluginSettingsDraft(next.sources, next.rules);
      return api.updatePluginSettings({
        revision: settingsQuery.data?.revision ?? '',
        enabled: next.enabled,
        store_sources: storeSources,
        store_auth: storeAuth,
      });
    },
    onSuccess: (saved) => {
      toast.success(t('plugin.settings_saved'));
      queryClient.setQueryData(['management-plugin-settings'], saved);
      setDraft(null);
      setShowIssues(false);
      setHasConflict(false);
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
      void queryClient.invalidateQueries({ queryKey: ['management-config'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && apiErrorCode(err) === 'config_conflict') {
        setHasConflict(true);
        return;
      }
      toast.error(apiErrorCode(err) === 'write_busy' ? t('cfg.save_busy') : t('common.save_failed', { msg: describeError(err) }));
    },
  });

  if (settingsQuery.isLoading) {
    return <PageLoading variant="block" className={styles.empty} />;
  }
  if (settingsQuery.isError || !current) {
    return <LoadFailure className={styles['store-notice']} title={t('plugin.settings_load_failed')} error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  const update = (next: Partial<SettingsDraft>) => setDraft({ ...current, ...next });
  const updateRule = (index: number, patch: Partial<PluginStoreAuthRule>) => {
    update({ rules: current.rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)) });
  };
  const issueFor = (predicate: (issue: PluginSettingsIssue) => boolean) => (showIssues ? issues.find(predicate) : undefined);

  const handleSave = () => {
    if (issues.length > 0) {
      setShowIssues(true);
      toast.warning(t('plugin.settings_invalid'));
      return;
    }
    saveMutation.mutate(current);
  };

  const reload = () => {
    setDraft(null);
    setHasConflict(false);
    setShowIssues(false);
    void settingsQuery.refetch();
  };

  const typeLabels: Record<PluginStoreAuthType, string> = {
    bearer: t('plugin.auth_type_bearer'),
    'github-token': t('plugin.auth_type_github'),
    basic: t('plugin.auth_type_basic'),
    header: t('plugin.auth_type_header'),
    none: t('plugin.auth_type_none'),
  };
  const targetLabels: Record<PluginStoreAuthTarget, string> = {
    registry: t('plugin.auth_target_registry'),
    metadata: t('plugin.auth_target_metadata'),
    artifact: t('plugin.auth_target_artifact'),
  };
  const envLabels = {
    token_env: t('plugin.auth_token_env'),
    username_env: t('plugin.auth_username_env'),
    password_env: t('plugin.auth_password_env'),
    header_value_env: t('plugin.auth_header_value_env'),
  };

  return (
    <div className={styles.settings} data-plugin-panel="settings">
      {hasConflict && (
        <Notice
          tone="warning"
          title={t('plugin.settings_conflict')}
          description={t('plugin.settings_conflict_desc')}
          action={<Button size="small" onClick={reload}>{t('plugin.settings_reload')}</Button>}
        />
      )}

      <Card>
        <section className={styles['settings-section']}>
          <div>
            <h2 className={styles['settings-section-title']}>{t('plugin.settings_system')}</h2>
            <p className={styles['settings-section-desc']}>{t('plugin.settings_system_desc')}</p>
          </div>
          <div>
            <div className={styles['setting-row']}>
              <div>
                <div className={styles['setting-label']}>{t('plugin.settings_enabled')}</div>
                <div className={styles['setting-hint']}>{t('plugin.settings_enabled_hint')}</div>
              </div>
              <Switch
                checked={current.enabled}
                disabled={isDemo}
                onChange={(checked) => update({ enabled: checked })}
                aria-label={t('plugin.settings_enabled')}
              />
            </div>
            <div className={styles['setting-row']}>
              <div>
                <div className={styles['setting-label']}>{t('plugin.settings_dir')}</div>
                <div className={styles['setting-hint']}>{t('plugin.settings_dir_hint')}</div>
              </div>
              <code className={styles['status-strip-path']}>{settingsQuery.data?.dir}</code>
            </div>
          </div>
        </section>
      </Card>

      <Card>
        <section className={styles['settings-section']}>
          <div className={styles['settings-section-head']}>
            <div>
              <h2 className={styles['settings-section-title']}>{t('plugin.settings_sources')}</h2>
              <p className={styles['settings-section-desc']}>{t('plugin.settings_sources_desc')}</p>
            </div>
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={isDemo}
              onClick={() => update({ sources: [...current.sources, ''] })}
            >
              {t('plugin.settings_add_source')}
            </Button>
          </div>
          <div className={styles['source-list']}>
            <div className={styles['source-fixed']}>
              <SafetyCertificateOutlined />
              {t('plugin.settings_official_source')}
            </div>
            {current.sources.map((source, index) => {
              const issue = issueFor((candidate) => (candidate.kind === 'source-url' || candidate.kind === 'source-duplicate') && candidate.index === index);
              return (
                <div key={index} className={styles['source-row']}>
                  <div>
                    <Input
                      value={source}
                      disabled={isDemo}
                      placeholder="https://example.com/cliproxy-plugins/registry.json"
                      status={issue ? 'error' : undefined}
                      onChange={(event) => update({ sources: current.sources.map((value, position) => (position === index ? event.target.value : value)) })}
                      aria-label={t('plugin.settings_source_label', { n: index + 1 })}
                    />
                    {issue && (
                      <div className={styles['field-error']}>
                        {issue.kind === 'source-url' ? t('plugin.settings_source_invalid') : t('plugin.settings_source_duplicate')}
                      </div>
                    )}
                  </div>
                  <Tooltip title={t('common.delete')}>
                    <Button
                      icon={<DeleteOutlined />}
                      disabled={isDemo}
                      onClick={() => update({ sources: current.sources.filter((_, position) => position !== index) })}
                      aria-label={t('plugin.settings_remove_source', { n: index + 1 })}
                    />
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </section>
      </Card>

      <Card>
        <section className={styles['settings-section']}>
          <div className={styles['settings-section-head']}>
            <div>
              <h2 className={styles['settings-section-title']}>{t('plugin.settings_auth')}</h2>
              <p className={styles['settings-section-desc']}>{t('plugin.settings_auth_desc')}</p>
            </div>
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={isDemo}
              onClick={() => update({ rules: [...current.rules, newRule()] })}
            >
              {t('plugin.settings_add_rule')}
            </Button>
          </div>
          {current.rules.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('plugin.settings_auth_empty')} />
          ) : (
            <div className={styles['rule-list']}>
              {current.rules.map((rule, index) => {
                const matchIssue = issueFor((issue) => issue.kind === 'rule-match' && issue.index === index);
                const headerIssue = issueFor((issue) => issue.kind === 'rule-header' && issue.index === index);
                return (
                  <div key={index} className={styles['rule-card']} data-plugin-auth-rule={index}>
                    <div className={styles['rule-head']}>
                      <span className={styles['rule-title']}>{rule.match.trim() || t('plugin.settings_rule_untitled', { n: index + 1 })}</span>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={isDemo}
                        onClick={() => update({ rules: current.rules.filter((_, position) => position !== index) })}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                    <div className={styles['rule-grid']}>
                      <label className={styles['rule-field']}>
                        <span className={styles['rule-field-label']}>{t('plugin.auth_match')}</span>
                        <Input
                          value={rule.match}
                          disabled={isDemo}
                          placeholder="https://api.github.com/repos/owner/"
                          status={matchIssue ? 'error' : undefined}
                          onChange={(event) => updateRule(index, { match: event.target.value })}
                        />
                        {matchIssue && <span className={styles['field-error']}>{t('plugin.auth_match_required')}</span>}
                      </label>
                      <label className={styles['rule-field']}>
                        <span className={styles['rule-field-label']}>{t('plugin.auth_type')}</span>
                        <Select
                          value={rule.type}
                          disabled={isDemo}
                          options={PLUGIN_STORE_AUTH_TYPES.map((type) => ({ value: type, label: typeLabels[type] }))}
                          onChange={(type: PluginStoreAuthType) => updateRule(index, { type })}
                        />
                      </label>
                      <div className={`${styles['rule-field']} ${styles['rule-field-wide']}`}>
                        <span className={styles['rule-field-label']}>{t('plugin.auth_apply_to')}</span>
                        <Checkbox.Group
                          value={rule.apply_to}
                          disabled={isDemo}
                          options={PLUGIN_STORE_AUTH_TARGETS.map((target) => ({ value: target, label: targetLabels[target] }))}
                          onChange={(values) => updateRule(index, { apply_to: values as PluginStoreAuthTarget[] })}
                        />
                        <span className={styles['setting-hint']}>{t('plugin.auth_apply_to_hint')}</span>
                      </div>
                      {rule.type === 'header' && (
                        <label className={styles['rule-field']}>
                          <span className={styles['rule-field-label']}>{t('plugin.auth_header_name')}</span>
                          <Input
                            value={rule.header_name ?? ''}
                            disabled={isDemo}
                            placeholder="X-Plugin-Token"
                            status={headerIssue ? 'error' : undefined}
                            onChange={(event) => updateRule(index, { header_name: event.target.value })}
                          />
                          {headerIssue && <span className={styles['field-error']}>{t('plugin.auth_header_invalid')}</span>}
                        </label>
                      )}
                      {authRuleEnvFields(rule.type).map((field) => {
                        const envIssue = issueFor((issue) => issue.kind === 'rule-env' && issue.index === index && issue.field === field);
                        return (
                          <label key={field} className={styles['rule-field']}>
                            <span className={styles['rule-field-label']}>{envLabels[field]}</span>
                            <Input
                              value={rule[field] ?? ''}
                              disabled={isDemo}
                              placeholder={ENV_PLACEHOLDERS[field]}
                              status={envIssue ? 'error' : undefined}
                              spellCheck={false}
                              onChange={(event) => updateRule(index, { [field]: event.target.value })}
                            />
                            {envIssue && <span className={styles['field-error']}>{t('plugin.auth_env_invalid')}</span>}
                          </label>
                        );
                      })}
                      <div className={`${styles['rule-field']} ${styles['rule-field-wide']}`}>
                        <Checkbox
                          checked={rule.allow_insecure}
                          disabled={isDemo}
                          onChange={(event) => updateRule(index, { allow_insecure: event.target.checked })}
                        >
                          {t('plugin.auth_allow_insecure')}
                        </Checkbox>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <span className={styles['setting-hint']}>{t('plugin.settings_auth_secret_note')}</span>
        </section>
      </Card>

      <div className={styles['settings-actions']}>
        {isDirty && <span className={styles['drawer-footer-note']}>{t('plugin.unsaved_changes')}</span>}
        <Button icon={<UndoOutlined />} disabled={!isDirty || saveMutation.isPending} onClick={() => { setDraft(null); setShowIssues(false); }}>
          {t('plugin.discard')}
        </Button>
        <Tooltip title={isDemo ? t('demo.blocked') : undefined}>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            disabled={isDemo || !isDirty}
            loading={saveMutation.isPending}
            onClick={handleSave}
          >
            {t('common.save')}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
