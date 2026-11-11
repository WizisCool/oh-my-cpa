import React from 'react';
import { RadioGroup, RadioItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useI18n, useT } from '../../i18n';
import { selectStorePluginMetadata } from '../../types/pluginStoreMetadata';
import type { StorePluginItem } from '../../types/plugin';
import { STORE_INSTALL_WARNINGS, storeInstallConfirmToken, storePluginOrigin, storeSourceLabel } from './pluginStoreLogic';
import { formatPluginVersion, PluginLogo, PluginMeta, PluginOriginBadge } from './PluginParts';
import styles from './Plugins.module.css';
import { useToast } from '../feedback';
import { Notice } from '../feedback';
import { AppModal } from '../common/AppModal';
import { UPDATE_STATUS_QUERY_KEY } from '../../hooks/useUpdateNotice';

interface PluginInstallModalProps {
  entry: StorePluginItem | null;
  isPluginSystemEnabled: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

/**
 * The install confirmation. It names the plugin and whose code it is, offers the newest
 * release or a named one, and for a plugin its listing registry does not maintain asks for
 * the plugin id to be typed: running someone else's code in the gateway should take more
 * than one click.
 */
export function PluginInstallModal({ entry, isPluginSystemEnabled, onClose, onOpenSettings }: PluginInstallModalProps) {
  const t = useT();
  const { lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [versionMode, setVersionMode] = React.useState<'latest' | 'pinned'>('latest');
  const [version, setVersion] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');

  React.useEffect(() => {
    setVersionMode('latest');
    setVersion('');
    setConfirmation('');
  }, [entry?.store_id]);

  const installMutation = useMutation({
    mutationFn: (target: StorePluginItem) =>
      api.installPlugin(target.id, {
        sourceId: target.source_id,
        version: versionMode === 'pinned' ? version.trim() : undefined,
      }),
    onSuccess: (result, target) => {
      const isUpdate = target.installed;
      const name = selectStorePluginMetadata(target, lang).name || target.id;
      const outcome = isUpdate
        ? t('plugin.update_success', { name, version: formatPluginVersion(result.version) })
        : t('plugin.install_success', { name, version: formatPluginVersion(result.version) });
      // Installed while the plugin system is off is still a success, but one that will not take
      // effect: one toast says both and offers the switch, rather than a success and a dialog.
      if (result.plugins_enabled) {
        toast.success(outcome);
      } else {
        toast.warning(outcome, {
          detail: t('plugin.installed_while_disabled'),
          actions: <Button size="sm" onClick={onOpenSettings}>{t('plugin.open_settings')}</Button>,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
      void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY });
      onClose();
    },
    onError: (err: unknown) => {
      const code = apiErrorCode(err);
      if (code === 'plugin_update_requires_restart') {
        toast.warning(t('plugin.update_restart_required'));
        return;
      }
      if (code === 'plugin_store_rate_limited') {
        toast.error(t('plugin.rate_limited'));
        return;
      }
      toast.error(t('plugin.install_failed', { msg: describeError(err) }));
    },
  });

  const handleClose = () => {
    if (!installMutation.isPending) onClose();
  };

  if (!entry) return null;

  const origin = storePluginOrigin(entry);
  const warning = STORE_INSTALL_WARNINGS[origin];
  const token = storeInstallConfirmToken(entry);
  const isVersionValid = versionMode === 'latest' || /^v?[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version.trim());
  // The warning block carries the only confirmation input, so its presence is the gate.
  const isConfirmed = !warning || confirmation.trim() === token;
  const metadata = selectStorePluginMetadata(entry, lang);
  const name = metadata.name || entry.id;

  return (
    <AppModal
      open
      title={entry.installed ? t('plugin.update_title', { name }) : t('plugin.install_title', { name })}
      onCancel={handleClose}
      onOk={() => installMutation.mutate(entry)}
      okText={entry.installed ? t('plugin.update') : t('plugin.install')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !isVersionValid || !isConfirmed, danger: Boolean(warning) }}
      confirmLoading={installMutation.isPending}
      mask={{ closable: !installMutation.isPending }}
      destroyOnHidden
    >
      <div className={styles['install-body']}>
        <div className={styles['install-identity']} data-plugin-install-identity>
          <PluginLogo logo={entry.logo} />
          <div className={styles['card-title']}>
            <span className={styles.badges}>
              <PluginOriginBadge origin={origin} />
              <span className={styles['plugin-id']}>{entry.id}</span>
            </span>
            <PluginMeta
              items={[
                metadata.author,
                t('plugin.from_source', { source: storeSourceLabel(entry, t) }),
                entry.platforms.length > 0 && t('plugin.platforms', { platforms: entry.platforms.join(', ') }),
              ]}
            />
          </div>
        </div>
        {metadata.description && <p className={styles['install-description']}>{metadata.description}</p>}
        {!isPluginSystemEnabled && <Notice tone="warning" title={t('plugin.installed_while_disabled')} />}
        <div>
          <div className={styles['setting-label']}>{t('plugin.version_label')}</div>
          <RadioGroup value={versionMode} onValueChange={(next) => setVersionMode(next as 'latest' | 'pinned')}>
            <RadioItem value="latest">{t('plugin.version_latest', { version: formatPluginVersion(entry.version) || '—' })}</RadioItem>
            <RadioItem value="pinned">{t('plugin.version_pinned')}</RadioItem>
          </RadioGroup>
          {versionMode === 'pinned' && (
            <div className={styles['install-version-row']}>
              <Input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder={t('plugin.version_placeholder')}
                status={version.trim() && !isVersionValid ? 'error' : undefined}
                aria-label={t('plugin.version_pinned')}
                className={styles['version-input']}
              />
            </div>
          )}
        </div>
        {warning && (
          <Notice
            tone="warning"
            title={t(warning.title)}
            description={(
              <div className={styles['install-body']}>
                <span>{t(warning.description)}</span>
                <label className={styles['rule-field']}>
                  <span className={styles['rule-field-label']}>{t('plugin.third_party_confirm', { token })}</span>
                  <Input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder={token}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
            )}
          />
        )}
      </div>
    </AppModal>
  );
}
