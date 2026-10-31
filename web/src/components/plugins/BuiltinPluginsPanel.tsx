import React from 'react';
import { Button } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ListLoading } from '../common/PageLoading';
import { InfoCircleOutlined, LockOutlined, SettingOutlined, WarningOutlined } from '../icons';
import { api, ApiError, apiErrorCode, describeError } from '../../api/client';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { formatPluginVersion, type BuiltinCatalogStatus, type BuiltinPlugin, type BuiltinPluginsResponse, type BuiltinPolicyUpdate, type BuiltinPluginPolicyUpdate, type PluginItem } from '../../types/plugin';
import { StatusLabel } from '../common/StatusLabel';
import { EmptyState } from '../common/EmptyState';
import { Panel } from '../common/Panel';
import { Tooltip } from '../common/Tooltip';
import { Switch } from '../common/Switch';
import { Notice, useToast } from '../feedback';
import {
  BUILTIN_OUTCOME_TIMEOUT_MS,
  BUILTIN_STATUS_TONES,
  builtinChanges,
  builtinReasonKey,
  builtinVersionFacts,
  builtinWriteFailure,
  needsAttention,
  waitForBuiltinOutcome,
  type BuiltinOutcomeWait,
} from './builtinPluginLogic';
import { pluginDescription } from './pluginDescription';
import { PluginRow } from './PluginParts';
import styles from './Plugins.module.css';

export const BUILTIN_PLUGINS_QUERY_KEY = ['management-builtin-plugins'] as const;

const CATALOG_NOTICES: Record<Exclude<BuiltinCatalogStatus, 'ready'>, { title: MessageKey; description: MessageKey }> = {
  unavailable: { title: 'plugin.builtin_catalog_unavailable_title', description: 'plugin.builtin_catalog_unavailable_desc' },
};

interface BuiltinPluginsPanelProps {
  data: BuiltinPluginsResponse | undefined;
  isLoading: boolean;
  isDemo: boolean;
  /** CPA's own plugin switch; while it is off nothing the automation installs can load. */
  isPluginSystemEnabled: boolean;
  /** CPA's view of the same plugins, by id: it carries their artwork and the pages they serve. */
  installed: ReadonlyMap<string, PluginItem>;
  actions: BuiltinActions;
  onOpenSettings: () => void;
  onConfigure: (plugin: PluginItem) => void;
}

/**
 * Oh My CPA's own plugins: one switch for all of them, and the plugins.
 *
 * On, OMC follows stable releases from the fixed official repositories. Release-check
 * failures are reported inside the switch's card. Off, OMC has uninstalled the copies
 * it manages, and the card is all there is. The plugins are rows drawn like the installed
 * list's, each with the same on/off meaning as an operator-installed plugin, and the same
 * settings drawer.
 */
/**
 * The writes the built-in page makes, and how each reports its outcome. The page header
 * holds the check for updates and the panel holds the switches, so both use one set:
 * while any of them runs, the others wait, and a switch flipped during a run is never
 * reported as that run's outcome.
 */
export function useBuiltinActions() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const accept = (response: BuiltinPluginsResponse) => queryClient.setQueryData(BUILTIN_PLUGINS_QUERY_KEY, response);
  const reread = () => queryClient.invalidateQueries({ queryKey: BUILTIN_PLUGINS_QUERY_KEY });
  const invalidateInstalled = () => queryClient.invalidateQueries({ queryKey: ['management-plugins'] });

  const reportFailure = (err: unknown) => {
    const failure = builtinWriteFailure(apiErrorCode(err), err instanceof ApiError ? err.status : 0);
    if (failure === 'refused') {
      toast.error(t('plugin.builtin_save_failed', { msg: describeError(err) }));
      return;
    }
    if (failure === 'conflict') toast.warning(t('plugin.builtin_conflict'));
    else if (failure === 'saved-unconfirmed') toast.warning(t('plugin.builtin_saved_unconfirmed'));
    else toast.warning(t('plugin.builtin_save_unknown'), { detail: describeError(err) });
    void reread();
    void invalidateInstalled();
  };

  // A run the console is waiting on ends with the page: nothing reads or reports after it.
  const lifetime = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  /** Reads until the worker has finished the run a request started, keeping the list current meanwhile. */
  const awaitRun = async (accepted: BuiltinPluginsResponse, before: BuiltinPluginsResponse | undefined) => {
    accept(accepted);
    const previousRunAt = (before ?? accepted).last_reconcile_at;
    return waitForBuiltinOutcome(previousRunAt, api.getBuiltinPlugins, accept, lifetime.current!.signal);
  };

  /**
   * One toast for what a run did: what it installed, updated or removed, and which plugins
   * still need the operator. `quiet` is the sentence for a run that changed nothing and
   * left nothing to do.
   */
  const reportRun = (title: string, before: readonly BuiltinPlugin[], wait: BuiltinOutcomeWait, quiet: string) => {
    if (!wait.isSettled) {
      toast.warning(t('plugin.builtin_outcome_unsettled_title'), { detail: t('plugin.builtin_outcome_unsettled', { seconds: BUILTIN_OUTCOME_TIMEOUT_MS / 1000 }) });
      return;
    }
    const { response } = wait;
    const changes = builtinChanges(before, response.plugins)
      .map((change) => t(`plugin.builtin_change_${change.kind}` as MessageKey, { name: change.name, version: change.version }));
    const attention = response.plugins.filter((plugin) => needsAttention(plugin, response.policy.enabled));
    if (attention.length > 0) {
      toast.warning(title, {
        detail: changes.length > 0 ? changes.join(' ') : t('plugin.builtin_outcome_attention', { n: attention.length }),
        items: attention.map((plugin) => ({
          name: plugin.name || plugin.id,
          reason: plugin.reason && builtinReasonKey(plugin.reason)
            ? t(builtinReasonKey(plugin.reason)!)
            : t(`plugin.builtin_status_${plugin.status}` as MessageKey),
        })),
      });
      return;
    }
    toast.success(title, { detail: changes.length > 0 ? changes.join(' ') : quiet });
  };

  const isRunAborted = (err: unknown) => lifetime.current?.signal.aborted && err === lifetime.current.signal.reason;

  const policyMutation = useMutation({
    mutationFn: async (update: BuiltinPolicyUpdate) => {
      const before = queryClient.getQueryData<BuiltinPluginsResponse>(BUILTIN_PLUGINS_QUERY_KEY);
      const response = await api.updateBuiltinPolicy(update);
      // Switching off uninstalls before the answer arrives; switching on starts a run.
      if (!update.enabled) return { before, wait: { isSettled: true, response } };
      return { before, wait: await awaitRun(response, before) };
    },
    onSuccess: ({ before, wait }) => {
      void invalidateInstalled();
      if (!wait.response.policy.enabled) {
        accept(wait.response);
        toast.success(t('plugin.builtin_paused'));
        return;
      }
      reportRun(t('plugin.builtin_resumed'), before?.plugins ?? [], wait, t('plugin.builtin_outcome_current'));
    },
    onError: (err) => { if (!isRunAborted(err)) reportFailure(err); },
  });

  const pluginMutation = useMutation({
    mutationFn: async ({ id, update }: { id: string; update: BuiltinPluginPolicyUpdate }) => {
      const before = queryClient.getQueryData<BuiltinPluginsResponse>(BUILTIN_PLUGINS_QUERY_KEY);
      const response = await api.updateBuiltinPluginPolicy(id, update);
      // The gateway has acted on a switched-off plugin by the time the answer arrives.
      if (!update.enabled) return { before, wait: { isSettled: true, response } };
      return { before, wait: await awaitRun(response, before) };
    },
    onSuccess: ({ before, wait }, { id, update }) => {
      void invalidateInstalled();
      const plugin = wait.response.plugins.find((item) => item.id === id);
      const name = plugin?.name || id;
      if (!update.enabled) {
        accept(wait.response);
        toast.success(t('plugin.builtin_plugin_disabled', { name }));
        return;
      }
      const running = plugin?.status === 'running' ? formatPluginVersion(plugin.runtime_version || plugin.installed_version) : '';
      reportRun(
        t('plugin.builtin_plugin_enabled', { name }),
        before?.plugins ?? [],
        wait,
        running ? t('plugin.builtin_outcome_running', { version: running }) : t('plugin.builtin_outcome_current'),
      );
    },
    onError: (err) => { if (!isRunAborted(err)) reportFailure(err); },
  });

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const before = queryClient.getQueryData<BuiltinPluginsResponse>(BUILTIN_PLUGINS_QUERY_KEY);
      return { before, wait: await awaitRun(await api.reconcileBuiltinPlugins(), before) };
    },
    onSuccess: ({ before, wait }) => {
      void invalidateInstalled();
      reportRun(t('plugin.builtin_check_done'), before?.plugins ?? [], wait, t('plugin.builtin_outcome_current'));
    },
    onError: (err) => { if (!isRunAborted(err)) toast.error(describeError(err)); },
  });

  const isWriting = policyMutation.isPending || pluginMutation.isPending || reconcileMutation.isPending;
  return { policyMutation, pluginMutation, reconcileMutation, isWriting };
}

export type BuiltinActions = ReturnType<typeof useBuiltinActions>;

export function BuiltinPluginsPanel({ data, isLoading, isDemo, isPluginSystemEnabled, installed, actions, onOpenSettings, onConfigure }: BuiltinPluginsPanelProps) {
  const { t, lang } = useI18n();
  const { policyMutation, pluginMutation, isWriting } = actions;

  if (isLoading || !data) {
    return isLoading ? <Panel><ListLoading className={styles.empty} /></Panel> : null;
  }

  const { policy, catalog, plugins } = data;
  const catalogNotice = catalog.status === 'ready' ? undefined : CATALOG_NOTICES[catalog.status];
  const demoTitle = isDemo ? t('demo.blocked') : undefined;
  const description = policy.enabled ? t('plugin.builtin_policy_desc') : t('plugin.builtin_feature_off_desc');

  return (
    <div className={styles['builtin-layout']} data-plugin-panel="builtins">
      <Panel>
        <section className={styles.automation} data-builtin-enabled={policy.enabled}>
          <div className={styles['automation-main']}>
            <h2 className={styles['automation-title']}>{t('plugin.builtin_policy_title')}</h2>
            <p className={styles.description}>{description}</p>
          </div>
          <Tooltip title={demoTitle}>
            <span>
              <Switch
                checked={policy.enabled}
                loading={policyMutation.isPending}
                disabled={isDemo || isWriting}
                onChange={(checked) => policyMutation.mutate({ enabled: checked, revision: policy.revision })}
                aria-label={t('plugin.builtin_automation_toggle')}
              />
            </span>
          </Tooltip>
        </section>

        {/* Switched off, OMC has uninstalled every copy it manages: there is no catalog to
            follow and no plugin to list, so the card is all the page holds. */}
        {policy.enabled && (
          <>
            {catalogNotice && (
              <Notice
                className={styles['automation-notice']}
                tone="warning"
                icon={<LockOutlined />}
                title={t(catalogNotice.title)}
                description={t(catalogNotice.description)}
              />
            )}
          </>
        )}
      </Panel>

      {policy.enabled && !isPluginSystemEnabled && (
        <Notice
          tone="warning"
          title={t('plugin.system_disabled_title')}
          description={t('plugin.builtin_system_disabled_desc')}
          action={<Button size="small" onClick={onOpenSettings}>{t('plugin.open_settings')}</Button>}
        />
      )}

      {policy.enabled && (
        <Panel>
          {plugins.length === 0 ? (
            <EmptyState className={styles.empty} title={t('plugin.builtin_empty')} />
          ) : (
            <div className={styles['installed-list']}>
              {plugins.map((plugin) => (
                <BuiltinRow
                  key={plugin.id}
                  plugin={plugin}
                  installed={installed.get(plugin.id)}
                  description={pluginDescription(lang, plugin)}
                  isDemo={isDemo}
                  isBusy={pluginMutation.isPending && pluginMutation.variables?.id === plugin.id}
                  isDisabled={isWriting}
                  onChange={(enabled) => pluginMutation.mutate({ id: plugin.id, update: { enabled, revision: policy.revision } })}
                  onConfigure={onConfigure}
                />
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

interface BuiltinRowProps {
  plugin: BuiltinPlugin;
  /** CPA's entry for the plugin; absent while it is not installed, which leaves nothing to configure. */
  installed: PluginItem | undefined;
  description: string;
  isDemo: boolean;
  isBusy: boolean;
  isDisabled: boolean;
  onChange: (enabled: boolean) => void;
  onConfigure: (plugin: PluginItem) => void;
}

function BuiltinRow({ plugin, installed, description, isDemo, isBusy, isDisabled, onChange, onConfigure }: BuiltinRowProps) {
  const { t } = useI18n();
  const name = plugin.name || plugin.id;
  const reasonKey = plugin.reason ? builtinReasonKey(plugin.reason) : undefined;
  const tone = BUILTIN_STATUS_TONES[plugin.status];
  const versions = builtinVersionFacts(plugin);

  return (
    <PluginRow
      rowProps={{ 'data-plugin-id': plugin.id, 'data-builtin-status': plugin.status }}
      logo={installed?.logo || installed?.metadata?.logo}
      name={name}
      id={plugin.id}
      status={<StatusLabel tone={tone}>{t(`plugin.builtin_status_${plugin.status}` as MessageKey)}</StatusLabel>}
      meta={[
        versions.current && <span className={styles['meta-strong']}>{versions.current}</span>,
        versions.update && <span className={styles['meta-accent']}>{t('plugin.builtin_update_to', { version: versions.update })}</span>,
        versions.available && t('plugin.builtin_target_version', { version: versions.available }),
        versions.running && t('plugin.builtin_runtime_version', { version: versions.running }),
        installed && installed.config_fields.length > 0 && t('plugin.config_field_count', { n: installed.config_fields.length }),
      ]}
      description={description}
      note={plugin.reason ? (
        <p className={styles['row-note']} data-tone={tone} data-builtin-reason={plugin.reason}>
          {tone === 'danger' || tone === 'warn' ? <WarningOutlined /> : <InfoCircleOutlined />}
          <span>{reasonKey ? t(reasonKey) : plugin.reason}</span>
        </p>
      ) : undefined}
      control={(
        <Switch
          size="small"
          checked={plugin.policy.enabled}
          loading={isBusy}
          disabled={isDemo || isDisabled}
          title={isDemo ? t('demo.blocked') : undefined}
          onChange={onChange}
          aria-label={t('plugin.toggle_label', { name })}
        />
      )}
      tools={installed && (
        <Tooltip title={t('plugin.configure')}>
          <Button
            size="small"
            className="row-action-btn"
            icon={<SettingOutlined />}
            onClick={() => onConfigure(installed)}
            aria-label={t('plugin.configure_label', { name })}
          />
        </Tooltip>
      )}
    />
  );
}
