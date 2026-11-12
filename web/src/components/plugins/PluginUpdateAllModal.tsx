import React from 'react';
import { Input } from '@/components/ui/input';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useI18n, useT } from '../../i18n';
import { UPDATE_STATUS_QUERY_KEY } from '../../hooks/useUpdateNotice';
import type { StorePluginItem } from '../../types/plugin';
import { selectStorePluginMetadata } from '../../types/pluginStoreMetadata';
import { AppModal } from '../common/AppModal';
import { Notice, useToast } from '../feedback';
import { formatPluginVersion, PluginLogo } from './PluginParts';
import { isStoreInstallBlocked, STORE_INSTALL_WARNINGS, storeInstallConfirmToken, storePluginOrigin } from './pluginStoreLogic';
import styles from './Plugins.module.css';

interface Props {
  entries: StorePluginItem[];
  isPluginSystemEnabled: boolean;
  onClose: () => void;
}

export function PluginUpdateAllModal({ entries, isPluginSystemEnabled, onClose }: Props) {
  const t = useT();
  const { lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmations, setConfirmations] = React.useState<Record<string, string>>({});
  const [results, setResults] = React.useState<Array<{ entry: StorePluginItem; error?: string }> | null>(null);
  const inFlight = React.useRef(false);
  const eligible = entries.filter((entry) => !isStoreInstallBlocked(entry));
  const confirmed = eligible.every((entry) => !STORE_INSTALL_WARNINGS[storePluginOrigin(entry)] || confirmations[entry.id]?.trim() === storeInstallConfirmToken(entry));
  const mutation = useMutation({
    mutationFn: async () => {
      const outcomes: Array<{ entry: StorePluginItem; error?: string }> = [];
      for (const entry of eligible) {
        try {
          await api.installPlugin(entry.id, { sourceId: entry.source_id });
          outcomes.push({ entry });
        } catch (error) {
          const code = apiErrorCode(error);
          outcomes.push({ entry, error: code === 'plugin_update_requires_restart' ? t('plugin.update_restart_required') : code === 'plugin_store_rate_limited' ? t('plugin.rate_limited') : describeError(error) });
        }
      }
      return outcomes;
    },
    onSettled: () => { inFlight.current = false; },
    onSuccess: (outcomes) => {
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
      void queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_QUERY_KEY });
      if (outcomes.length === entries.length && outcomes.every((outcome) => !outcome.error)) {
        const message = t('plugin.update_all_success', { n: outcomes.length });
        if (isPluginSystemEnabled) toast.success(message);
        else toast.warning(message, { detail: t('plugin.installed_while_disabled') });
        onClose();
      } else {
        setResults(outcomes);
      }
    },
  });

  return (
    <AppModal
      open
      title={t('plugin.update_all_title')}
      onCancel={() => { if (!mutation.isPending) onClose(); }}
      onOk={() => {
        if (results) onClose();
        else if (!inFlight.current) {
          inFlight.current = true;
          mutation.mutate();
        }
      }}
      okText={results ? t('common.close') : t('plugin.update_all')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !results && (!eligible.length || !confirmed) }}
      confirmLoading={mutation.isPending}
      isDismissible={!mutation.isPending}
      cancelButtonProps={{ disabled: mutation.isPending, style: results ? { display: 'none' } : undefined }}
      mask={{ closable: !mutation.isPending }}
      destroyOnHidden
    >
      <div className={styles['install-body']}>
        {!isPluginSystemEnabled && <Notice tone="warning" title={t('plugin.installed_while_disabled')} />}
        {entries.map((entry) => {
          const warning = STORE_INSTALL_WARNINGS[storePluginOrigin(entry)];
          const blocked = isStoreInstallBlocked(entry);
          const outcome = results?.find((result) => result.entry.id === entry.id);
          const name = selectStorePluginMetadata(entry, lang).name || entry.id;
          return (
            <div className={styles['bulk-update-item']} key={entry.id}>
              <div className={styles['bulk-update-heading']}>
                <PluginLogo logo={entry.logo} />
                <div className={styles['bulk-update-identity']}>
                  <span>{name}</span>
                  <span className={styles['plugin-id']}>{entry.id}</span>
                </div>
                <span className={styles.meta}>{formatPluginVersion(entry.installed_version) || '—'} → {formatPluginVersion(entry.version) || '—'}</span>
              </div>
              {blocked && <Notice tone="warning" title={t('plugin.auth_required_hint')} />}
              {outcome && <Notice tone={outcome.error ? 'warning' : 'success'} title={outcome.error || t('plugin.update_all_item_success')} />}
              {!results && !blocked && warning && (
                <Notice tone="warning" title={t(warning.title)} description={(
                  <div className={styles['install-body']}>
                    <span>{t(warning.description)}</span>
                    <label className={styles['rule-field']}>
                      <span className={styles['rule-field-label']}>{t('plugin.third_party_confirm', { token: storeInstallConfirmToken(entry) })}</span>
                      <Input value={confirmations[entry.id] || ''} onChange={(event) => setConfirmations((current) => ({ ...current, [entry.id]: event.target.value }))} placeholder={entry.id} autoComplete="off" spellCheck={false} disabled={mutation.isPending} />
                    </label>
                  </div>
                )} />
              )}
            </div>
          );
        })}
      </div>
    </AppModal>
  );
}
