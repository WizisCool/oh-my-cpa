import React from 'react';
import { Button, Input, Select } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import type { OutboundProxyInput, OutboundProxyMode, OutboundProxySettings as Settings } from '../../types/outboundProxy';
import { SectionHeading } from '../common/SectionHeading';
import { SecretInput } from '../common/SecretInput';
import { SettingRow } from '../common/SettingRow';
import { LoadFailure, Notice, useToast } from '../feedback';

const QUERY_KEY = ['outbound-proxy'];

function ProxyForm({ settings }: { settings: Settings }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<OutboundProxyMode>(settings.mode);
  const [url, setURL] = React.useState('');
  const [noProxy, setNoProxy] = React.useState(settings.no_proxy);
  const save = useMutation({
    mutationFn: (input: OutboundProxyInput) => api.setOutboundProxy(input),
    onSuccess: (saved) => {
      setURL('');
      queryClient.setQueryData(QUERY_KEY, saved);
      toast.success(t('omc.proxy_saved'));
      if (!saved.cpa_revision) void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => {
      toast.error(t('omc.proxy_save_failed', { msg: describeError(error) }));
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const isDisabled = isDemoMode() || save.isPending || !settings.cpa_revision;
  const submit = () => {
    const input: OutboundProxyInput = {
      mode,
      no_proxy: mode === 'proxy' ? noProxy.trim() : '',
      revision: settings.revision,
      cpa_revision: settings.cpa_revision,
    };
    if (mode === 'proxy' && url.trim()) input.url = url.trim();
    save.mutate(input);
  };
  return (
    <>
      {settings.cpa_in_sync === false && (
        <div className="settings-inline-notice">
          <Notice tone="warning" description={t('omc.proxy_cpa_out_of_sync')} />
        </div>
      )}
      <SettingRow label={t('omc.proxy_mode')} control={(
        <Select<OutboundProxyMode>
          value={mode}
          onChange={setMode}
          disabled={isDisabled}
          aria-label={t('omc.proxy_mode')}
          options={[
            { value: 'environment', label: t('omc.proxy_environment') },
            { value: 'direct', label: t('omc.proxy_direct') },
            { value: 'proxy', label: t('omc.proxy_custom') },
          ]}
        />
      )} />
      {mode === 'proxy' && (
        <>
          <SettingRow label={t('omc.proxy_address')} description={t('omc.proxy_address_desc')} control={(
            <SecretInput value={url} onChange={(event) => setURL(event.target.value)} placeholder={settings.address || 'http://proxy:7890'} disabled={isDisabled} aria-label={t('omc.proxy_address')} />
          )} />
          <SettingRow label={t('omc.proxy_exclusions')} description={t('omc.proxy_exclusions_desc')} control={(
            <Input value={noProxy} onChange={(event) => setNoProxy(event.target.value)} placeholder="localhost,.internal" disabled={isDisabled} aria-label={t('omc.proxy_exclusions')} />
          )} />
        </>
      )}
      {mode !== 'environment' && (
        <div className="settings-inline-notice">
          <Notice tone="warning" description={t('omc.proxy_backup_warning')} />
        </div>
      )}
      <SettingRow label={t('omc.proxy_apply')} description={t('omc.proxy_apply_desc')} control={(
        <Button type="primary" onClick={submit} loading={save.isPending} disabled={isDisabled}>{t('common.save')}</Button>
      )} />
    </>
  );
}

export function OutboundProxySettings() {
  const t = useT();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: api.getOutboundProxy });
  return (
    <div className="settings-group omc-settings-group">
      <SectionHeading className="settings-group-head" title={t('omc.section_proxy')} />
      {query.isError && <LoadFailure title={t('omc.proxy_load_failed')} error={query.error} onRetry={() => { void query.refetch(); }} />}
      {query.data && <ProxyForm key={query.data.revision} settings={query.data} />}
    </div>
  );
}
