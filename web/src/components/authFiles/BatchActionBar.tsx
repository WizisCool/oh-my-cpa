import React from 'react';
import { Button } from 'antd';
import {
  CheckCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  CloseOutlined,
  SyncOutlined,
} from '../icons';
import { useT } from '../../i18n';
import { ConfirmAction } from '../common/ConfirmAction';
import { SelectionBar } from '../common/SelectionBar';
import styles from './BatchActionBar.module.css';

interface BatchActionBarProps {
  selectedCount: number;
  selectablePageCount: number;
  selectableFilteredCount: number;
  canSelectFiltered: boolean;
  isSelectionReady: boolean;
  onSelectFiltered: () => void;
  isMutating: boolean;
  onSelectPage: () => void;
  onClearSelection: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onRefresh: () => void;
  canRefresh: boolean;
  onDelete: () => void;
  hiddenCount?: number;
}

export const BatchActionBar: React.FC<BatchActionBarProps> = ({
  selectedCount,
  selectablePageCount,
  selectableFilteredCount,
  canSelectFiltered,
  isSelectionReady,
  onSelectFiltered,
  isMutating,
  onSelectPage,
  onClearSelection,
  onEnable,
  onDisable,
  onRefresh,
  canRefresh,
  onDelete,
  hiddenCount = 0,
}) => {
  const t = useT();

  const hasSelection = selectedCount > 0;
  if (!hasSelection) {
    return null;
  }

  return (
    <SelectionBar
      variant="inline"
      className={styles.bar}
      label={t('af.selected_n', { n: selectedCount })}
      summary={t('af.selected_n', { n: selectedCount })}
      note={hiddenCount > 0 ? t('omc.hidden_selection', { n: hiddenCount }) : undefined}
      selection={(
        <div className={styles['scope-controls']}>
          <Button size="small" disabled={isMutating || !isSelectionReady || selectablePageCount === 0} onClick={onSelectPage}>
            {t('af.select_page')}
          </Button>
          <Button className={styles['scope-filtered']} size="small" disabled={isMutating || !isSelectionReady || !canSelectFiltered} onClick={onSelectFiltered}>
            {t('af.select_filtered', { n: selectableFilteredCount })}
          </Button>
          <Button className={styles['scope-clear']} size="small" type="text" icon={<CloseOutlined />} disabled={isMutating} onClick={onClearSelection}>
            {t('af.clear_selection')}
          </Button>
        </div>
      )}
    >
      <Button
        size="small"
        icon={<CheckCircleOutlined />}
        loading={isMutating}
        disabled={isMutating}
        onClick={onEnable}
      >
        {t('af.batch_enable')}
      </Button>
      <Button
        size="small"
        icon={<StopOutlined />}
        loading={isMutating}
        disabled={isMutating}
        onClick={onDisable}
      >
        {t('af.batch_disable')}
      </Button>
      <Button
        size="small"
        icon={<SyncOutlined />}
        loading={isMutating}
        disabled={isMutating || !canRefresh}
        onClick={onRefresh}
      >
        {t('af.batch_refresh')}
      </Button>
      <div className={styles['destructive-action']}>
        <ConfirmAction
          title={t('af.delete_selected_title')}
          description={hiddenCount > 0
            ? `${t('af.delete_selected_desc')} ${t('omc.delete_hidden_scope', { hidden: hiddenCount, total: selectedCount })}`
            : t('af.delete_selected_desc')}
          confirmLabel={t('common.delete')}
          isDanger
          onConfirm={onDelete}
        >
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            loading={isMutating}
            disabled={isMutating}
          >
            {t('af.delete_selected')}
          </Button>
        </ConfirmAction>
      </div>
    </SelectionBar>
  );
};
