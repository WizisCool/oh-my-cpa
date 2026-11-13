import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DropdownCaret } from '@/components/ui/dropdown-caret';
import {
  CheckCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  CloseOutlined,
  SyncOutlined,
} from '../icons';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useT } from '../../i18n';
import { ConfirmAction } from '../common/ConfirmAction';
import { SelectionBar } from '../common/SelectionBar';
import { ToolButton } from '../common/ToolButton';
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
  const isPhone = useIsPhoneViewport();

  const hasSelection = selectedCount > 0;
  if (!hasSelection) {
    return null;
  }

  const deleteDescription = hiddenCount > 0
    ? `${t('af.delete_selected_desc')} ${t('omc.delete_hidden_scope', { hidden: hiddenCount, total: selectedCount })}`
    : t('af.delete_selected_desc');

  // A phone holds the bar on one line, as the request list's does: the count with how far it
  // reaches, then the actions as glyphs, delete set apart, and the way out last.
  if (isPhone) {
    return (
      <SelectionBar
        className={styles.bar}
        label={t('af.selected_n', { n: selectedCount })}
        summary={t('af.selected_n', { n: selectedCount })}
        note={hiddenCount > 0 ? t('omc.hidden_selection', { n: hiddenCount }) : undefined}
        selection={(
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isMutating || !isSelectionReady}
              render={(
                <Button size="sm" variant="ghost" className={styles['scope-menu']} disabled={isMutating || !isSelectionReady}>
                  {t('pro.select_all')}
                  <DropdownCaret />
                </Button>
              )}
            />
            <DropdownMenuContent placement="topLeft">
              <DropdownMenuItem disabled={selectablePageCount === 0} onClick={onSelectPage}>{t('af.select_page')}</DropdownMenuItem>
              <DropdownMenuItem disabled={!canSelectFiltered} onClick={onSelectFiltered}>{t('af.select_filtered', { n: selectableFilteredCount })}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      >
        <ToolButton size="sm" variant="ghost" icon={<CheckCircleOutlined />} label={t('af.batch_enable')} disabled={isMutating} onClick={onEnable} />
        <ToolButton size="sm" variant="ghost" icon={<StopOutlined />} label={t('af.batch_disable')} disabled={isMutating} onClick={onDisable} />
        <ToolButton size="sm" variant="ghost" icon={<SyncOutlined />} label={t('af.batch_refresh')} disabled={isMutating || !canRefresh} onClick={onRefresh} />
        <ConfirmAction title={t('af.delete_selected_title')} description={deleteDescription} confirmLabel={t('common.delete')} isDanger onConfirm={onDelete}>
          <ToolButton size="sm" variant="ghost" danger icon={<DeleteOutlined />} label={t('af.delete_selected')} disabled={isMutating} />
        </ConfirmAction>
        <span className={styles['phone-divider']} aria-hidden="true" />
        <ToolButton size="sm" variant="ghost" icon={<CloseOutlined />} label={t('af.clear_selection')} disabled={isMutating} onClick={onClearSelection} />
      </SelectionBar>
    );
  }

  return (
    <SelectionBar
      className={styles.bar}
      label={t('af.selected_n', { n: selectedCount })}
      summary={t('af.selected_n', { n: selectedCount })}
      note={hiddenCount > 0 ? t('omc.hidden_selection', { n: hiddenCount }) : undefined}
      selection={(
        <div className={styles['scope-controls']}>
          <Button size="sm" disabled={isMutating || !isSelectionReady || selectablePageCount === 0} onClick={onSelectPage}>
            {t('af.select_page')}
          </Button>
          <Button className={styles['scope-filtered']} size="sm" disabled={isMutating || !isSelectionReady || !canSelectFiltered} onClick={onSelectFiltered}>
            {t('af.select_filtered', { n: selectableFilteredCount })}
          </Button>
          <Button className={styles['scope-clear']} size="sm" variant="ghost" icon={<CloseOutlined />} disabled={isMutating} onClick={onClearSelection}>
            {t('af.clear_selection')}
          </Button>
        </div>
      )}
    >
      <Button
        size="sm"
        icon={<CheckCircleOutlined />}
        loading={isMutating}
        disabled={isMutating}
        onClick={onEnable}
      >
        {t('af.batch_enable')}
      </Button>
      <Button
        size="sm"
        icon={<StopOutlined />}
        loading={isMutating}
        disabled={isMutating}
        onClick={onDisable}
      >
        {t('af.batch_disable')}
      </Button>
      <Button
        size="sm"
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
          description={deleteDescription}
          confirmLabel={t('common.delete')}
          isDanger
          onConfirm={onDelete}
        >
          <Button
            size="sm"
            variant="ghost"
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
