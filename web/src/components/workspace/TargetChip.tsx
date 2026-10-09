import React from 'react';
import { Button, Input } from 'antd';
import { LabelTip } from '../common/LabelTip';
import { useI18n } from '../../i18n';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import type { GatewayModelItem } from '../../types/gatewayModels';
import type { ClientAPIKeyItem } from '../../types/providers';
import { ArrowLeftOutlined, BoxOutlined, DownOutlined, KeyOutlined, LoadingOutlined, ReloadOutlined, SearchOutlined } from '../icons';
import { ModelMark } from './ModelMark';
import { ComposerPicker, ComposerPickerList } from './ComposerPicker';
import styles from './Workspace.module.css';

export interface TargetChipProps {
  keys: ClientAPIKeyItem[];
  models: GatewayModelItem[];
  fingerprint: string;
  model: string;
  isKeysLoading: boolean;
  isModelsLoading: boolean;
  isDisabled: boolean;
  /** The remembered target has not been read yet. */
  isPending?: boolean;
  onFingerprintChange: (fingerprint: string) => void;
  onModelChange: (model: string) => void;
  onRefresh: () => void;
  emptyHint?: React.ReactNode;
}

const SEARCH_THRESHOLD = 8;

/** Models lead; changing the key uses a second view of the same surface, never a nested popup. */
export function TargetChip({
  keys, models, fingerprint, model, isKeysLoading, isModelsLoading, isDisabled, isPending = false, onFingerprintChange, onModelChange, onRefresh, emptyHint,
}: TargetChipProps) {
  const { t } = useI18n();
  const [isChoosingKey, setIsChoosingKey] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const contentRef = React.useRef<HTMLDivElement>(null);
  const callPoints = React.useMemo(() => [...new Set(models.map(gatewayCallPointOf))], [models]);
  const keyOptions = React.useMemo(() => keys.filter(key => Boolean(key.usage_fingerprint)).map(key => ({
    value: key.usage_fingerprint as string,
    label: key.alias || key.key,
    detail: key.alias ? key.key : undefined,
    icon: <KeyOutlined />,
  })), [keys]);
  const selectedKey = keyOptions.find(key => key.value === fingerprint);
  const needle = query.trim().toLowerCase();
  const visible = needle ? callPoints.filter(callPoint => callPoint.toLowerCase().includes(needle)) : callPoints;
  const isLoading = isChoosingKey ? isKeysLoading : isModelsLoading;
  // A re-read keeps the list it is re-reading: swapping it for a loading line collapsed the
  // surface and grew it back a moment later. Only a list with nothing to show yet says so.
  const isAwaitingFirstRead = isLoading && (isChoosingKey ? keyOptions.length === 0 : callPoints.length === 0);

  React.useEffect(() => {
    const first = contentRef.current?.querySelector<HTMLElement>('[data-picker-search] input, [data-picker-list] [tabindex="0"]');
    first?.focus({ preventScroll: true });
  }, [isChoosingKey, isAwaitingFirstRead]);

  return (
    <ComposerPicker
      label={t('conversation.model')}
      valueLabel={model || t('conversation.target.choose')}
      icon={model ? <ModelMark callPoint={model} /> : <BoxOutlined />}
      testId="target-chip"
      contentTestId="target-popover"
      className={styles['target-chip']}
      isUnset={!model}
      isPending={isPending}
      isDisabled={isDisabled}
      onOpenChange={() => { setQuery(''); setIsChoosingKey(false); }}
    >
      {close => (
        <div ref={contentRef} className={styles['picker-body']}>
          <div className={styles['picker-head']}>
            {isChoosingKey && <Button type="text" size="small" aria-label={t('conversation.target.back')} icon={<ArrowLeftOutlined />} onClick={() => { setIsChoosingKey(false); setQuery(''); }} />}
            <span>{t(isChoosingKey ? 'conversation.client_key' : 'conversation.model')}</span>
            {!isChoosingKey && <span className={styles['picker-count']}>{isModelsLoading ? <LoadingOutlined /> : callPoints.length}</span>}
            {!isChoosingKey && <LabelTip title={t('common.refresh')}><Button type="text" size="small" className={styles['picker-refresh']} aria-label={t('common.refresh')} icon={<ReloadOutlined />} loading={isLoading} onClick={onRefresh} /></LabelTip>}
          </div>
          {!isChoosingKey && callPoints.length > SEARCH_THRESHOLD && (
            <div className={styles['picker-search']} data-picker-search>
              <Input
                variant="borderless"
                allowClear
                aria-label={t('conversation.target.search')}
                placeholder={t('conversation.target.search')}
                prefix={<SearchOutlined aria-hidden="true" />}
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
            </div>
          )}
          {isAwaitingFirstRead ? <div className={styles['picker-empty']} role="status">{t('common.loading')}</div> : isChoosingKey ? (
            keyOptions.length > 0 ? <ComposerPickerList key="keys" label={t('conversation.client_key')} options={keyOptions} value={fingerprint} onSelect={next => {
              if (next !== fingerprint) onFingerprintChange(next);
              setQuery('');
              setIsChoosingKey(false);
            }} /> : <div className={styles['picker-empty']}>{emptyHint ?? t('conversation.target.pick_key')}</div>
          ) : visible.length > 0 ? (
            <ComposerPickerList key={`models:${fingerprint}:${needle}`} label={t('conversation.model')} options={visible.map(callPoint => ({ value: callPoint, label: callPoint, icon: <ModelMark callPoint={callPoint} /> }))} value={model} optionTestId="target-model" onSelect={next => { onModelChange(next); close(); }} />
          ) : <div className={styles['picker-empty']}>{needle ? t('conversation.target.no_match') : emptyHint ?? t(fingerprint ? 'pg.no_models' : 'conversation.target.pick_key')}</div>}
          {!isChoosingKey && (
            <button type="button" className={styles['picker-key']} onClick={() => setIsChoosingKey(true)}>
              <KeyOutlined aria-hidden="true" />
              <span className={styles['picker-key-copy']}><span className={styles['picker-key-label']}>{t('conversation.client_key')}</span><span className={styles['picker-key-name']}>{selectedKey?.label || t('conversation.target.pick_key')}</span></span>
              <DownOutlined className={styles['picker-caret']} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </ComposerPicker>
  );
}
