import React from 'react';
import { Checkbox, Input, Modal } from 'antd';
import { SearchOutlined } from '../icons';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { filterModelOptions } from '../../utils/modelOptions';
import styles from './ModelPickerModal.module.css';

interface ModelPickerModalProps {
  isOpen: boolean;
  /** The catalog the provider's endpoint returned, already sorted and deduplicated. */
  models: string[];
  /** Names the provider already has rows for; shown ticked and fixed. */
  configured: ReadonlySet<string>;
  onApply: (picked: string[]) => void;
  onClose: () => void;
}

/**
 * Chooses several fetched models at once.
 *
 * A relay's catalog runs to dozens or hundreds of ids, and the per-row
 * autocomplete made each one a separate add-then-type round. Configured models
 * stay in the list, ticked and fixed, so the operator sees the whole catalog
 * against what the provider already serves instead of a list with holes in it.
 */
export function ModelPickerModal({ isOpen, models, configured, onApply, onClose }: ModelPickerModalProps) {
  const t = useT();
  const [query, setQuery] = React.useState('');
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());

  useOverlayHistory({ isOpen, onClose });

  // Each opening starts from the provider's current rows, not from a previous
  // pick the operator dismissed.
  React.useEffect(() => {
    if (isOpen) {
      setQuery('');
      setPicked(new Set());
    }
  }, [isOpen]);

  const visible = filterModelOptions(models, query);
  const visiblePickable = visible.filter((name) => !configured.has(name));
  const pickedVisibleCount = visiblePickable.filter((name) => picked.has(name)).length;
  const isAllVisiblePicked = visiblePickable.length > 0 && pickedVisibleCount === visiblePickable.length;

  const togglePicked = (name: string, isChecked: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (isChecked) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  // Select-all acts on what the search shows, so "search, then select all" picks
  // one family of models without touching picks made under an earlier search.
  const toggleAllVisible = (isChecked: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const name of visiblePickable) {
        if (isChecked) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  };

  return (
    <Modal
      title={t('pro.pick_models')}
      open={isOpen}
      onCancel={onClose}
      onOk={() => onApply(models.filter((name) => picked.has(name)))}
      okText={t('pro.apply_models', { n: picked.size })}
      okButtonProps={{ disabled: picked.size === 0 }}
      cancelText={t('common.cancel')}
      destroyOnHidden
    >
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('pro.search_models')}
        prefix={<SearchOutlined />}
        allowClear
        autoFocus
        aria-label={t('pro.search_models')}
      />
      <div className={styles['toolbar']}>
        <Checkbox
          checked={isAllVisiblePicked}
          indeterminate={pickedVisibleCount > 0 && !isAllVisiblePicked}
          disabled={visiblePickable.length === 0}
          onChange={(event) => toggleAllVisible(event.target.checked)}
        >
          {t('pro.select_all')}
        </Checkbox>
        <span>{t('pro.models_picked', { n: picked.size, total: models.length })}</span>
      </div>
      <div className={styles['list']} role="group" aria-label={t('pro.pick_models')}>
        {visible.length === 0 ? (
          <div className={styles['empty']}>{t('pro.no_matching_models')}</div>
        ) : (
          visible.map((name) => {
            const isConfigured = configured.has(name);
            return (
              <div
                key={name}
                className={`${styles['row']} ${isConfigured ? styles['row-configured'] : ''}`}
              >
                <Checkbox
                  checked={isConfigured || picked.has(name)}
                  disabled={isConfigured}
                  onChange={(event) => togglePicked(name, event.target.checked)}
                >
                  <span className={styles['name']}>{name}</span>
                </Checkbox>
                {isConfigured && <span className={styles['configured-tag']}>{t('pro.model_added')}</span>}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
