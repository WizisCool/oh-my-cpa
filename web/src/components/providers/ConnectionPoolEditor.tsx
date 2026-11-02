import { Checkbox, Input, InputNumber, Segmented } from 'antd';
import { useId } from 'react';
import { useT } from '../../i18n';
import type { ProviderConnectionPoolSettings, ProviderOverride } from '../../types/providers';
import type { ConnectionPoolDraft } from './connectionPool';
import styles from './ProviderEditorDrawer.module.css';

interface Props {
  draft: ConnectionPoolDraft;
  onChange: (draft: ConnectionPoolDraft) => void;
  isGroup?: boolean;
  groupName?: string;
  groupSize?: number;
  defaults?: ProviderConnectionPoolSettings | null;
}

export function ConnectionPoolEditor({ draft, onChange, isGroup = false, groupName, groupSize = 1, defaults = null }: Props) {
  const t = useT();
  const id = useId();
  const titleId = `${id}-title`;
  const inheritedPool = isGroup ? null : defaults;
  const options: { value: ProviderOverride; label: string }[] = [
    { value: 'inherit', label: t(isGroup ? 'pool.default_fields' : 'pool.inherit_fields') },
    { value: 'enabled', label: t('policy.override_enabled') },
    { value: 'disabled', label: t('policy.override_disabled') },
  ];
  return <div role="group" aria-labelledby={titleId} className={styles['pool']}>
    <div id={titleId} className={styles['item-field-label']}>{t(isGroup ? 'pool.group_title' : 'pool.key_title')}</div>
    {isGroup && <div className={styles['policy-desc']}>{groupName ? t('pool.group_scope', { name: groupName, count: groupSize }) : t('pool.new_scope', { count: groupSize })}</div>}
    <Checkbox checked={draft.isConfigured} onChange={event => onChange({ ...draft, isConfigured: event.target.checked })}>
      {t(isGroup ? 'pool.configure_group' : 'pool.configure_key')}
    </Checkbox>
    {draft.isConfigured && <>
      {!isGroup && <div className={styles['policy-desc']}>{t('pool.key_hint')}</div>}
      <div className={styles['policy-field']}>
        <div id={`${id}-enabled`} className={styles['item-field-label']}>{t('pool.enabled')}</div>
        <Segmented aria-labelledby={`${id}-enabled`} value={draft.enabled} options={options} onChange={enabled => onChange({ ...draft, enabled })} />
      </div>
      <div className={styles['policy-field']}>
        <label className={styles['item-field-label']} htmlFor={`${id}-timeout`}>{t('pool.timeout')}</label>
        <Input id={`${id}-timeout`} value={draft.idleConnTimeout} maxLength={128} placeholder={inheritedPool?.idle_conn_timeout || '300s'} onChange={event => onChange({ ...draft, idleConnTimeout: event.target.value })} />
      </div>
      <div className={styles['policy-field']}>
        <label className={styles['item-field-label']} htmlFor={`${id}-max`}>{t('pool.max_idle')}</label>
        <InputNumber id={`${id}-max`} className={styles['full-width']} value={draft.maxIdleConnsPerHost} precision={0} placeholder={String(inheritedPool?.max_idle_conns_per_host ?? 2)} onChange={maxIdleConnsPerHost => onChange({ ...draft, maxIdleConnsPerHost })} />
      </div>
      <div className={styles['policy-desc']}>{t('pool.limits_hint')}</div>
    </>}
  </div>;
}
