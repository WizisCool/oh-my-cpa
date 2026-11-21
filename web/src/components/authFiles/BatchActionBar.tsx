import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DropdownCaret } from '@/components/ui/dropdown-caret';
import {
  CheckCircleOutlined,
  CheckSquareOutlined,
  StopOutlined,
  DeleteOutlined,
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

type BatchAction = 'enable' | 'disable' | 'refresh' | 'delete';

/**
 * The OAuth list's selection bar. Desktop and phone share one anatomy - the way out, the count,
 * how to widen the choice, then the actions with delete set apart - and differ only in whether the
 * actions carry their words. Every action is the same quiet weight, so none reads as the page's
 * main task, and only the one that is running shows it.
 */
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
  const [lastAction, setLastAction] = React.useState<BatchAction | null>(null);

  if (selectedCount === 0) {
    return null;
  }

  const deleteDescription = hiddenCount > 0
    ? `${t('af.delete_selected_desc')} ${t('omc.delete_hidden_scope', { hidden: hiddenCount, total: selectedCount })}`
    : t('af.delete_selected_desc');
  const run = (action: BatchAction, handler: () => void) => () => {
    setLastAction(action);
    handler();
  };
  const isScopeDisabled = isMutating || !isSelectionReady;

  const actions: Array<{ key: BatchAction; icon: React.ReactNode; label: string; onClick: () => void; isDisabled?: boolean }> = [
    { key: 'enable', icon: <CheckCircleOutlined />, label: t('af.batch_enable'), onClick: run('enable', onEnable) },
    { key: 'disable', icon: <StopOutlined />, label: t('af.batch_disable'), onClick: run('disable', onDisable) },
    { key: 'refresh', icon: <SyncOutlined />, label: t('af.batch_refresh'), onClick: run('refresh', onRefresh), isDisabled: !canRefresh },
  ];
  const isRunning = (action: BatchAction) => isMutating && lastAction === action;
  const deleteButton = isPhone ? (
    <ToolButton size="sm" variant="ghost" danger icon={<DeleteOutlined />} label={t('af.delete_selected')} loading={isRunning('delete')} disabled={isMutating} />
  ) : (
    <Button size="sm" variant="ghost" danger icon={<DeleteOutlined />} loading={isRunning('delete')} disabled={isMutating}>
      {t('af.delete_selected')}
    </Button>
  );

  return (
    <SelectionBar
      label={t('af.selected_n', { n: selectedCount })}
      summary={t('af.selected_n', { n: selectedCount })}
      note={hiddenCount > 0 ? t('omc.hidden_selection', { n: hiddenCount }) : undefined}
      onClear={onClearSelection}
      clearLabel={t('af.clear_selection')}
      isClearDisabled={isMutating}
      selection={isPhone ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={isScopeDisabled}
            render={(
              <Button
                size="sm"
                variant="ghost"
                className={styles['scope-menu']}
                icon={<CheckSquareOutlined />}
                aria-label={t('pro.select_all')}
                data-tip={t('pro.select_all')}
                disabled={isScopeDisabled}
              >
                <DropdownCaret />
              </Button>
            )}
          />
          <DropdownMenuContent placement="topLeft">
            <DropdownMenuItem disabled={selectablePageCount === 0} onClick={onSelectPage}>{t('af.select_page')}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canSelectFiltered} onClick={onSelectFiltered}>{t('af.select_filtered', { n: selectableFilteredCount })}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <Button size="sm" variant="link" disabled={isScopeDisabled || selectablePageCount === 0} onClick={onSelectPage}>
            {t('af.select_page')}
          </Button>
          <Button size="sm" variant="link" disabled={isScopeDisabled || !canSelectFiltered} onClick={onSelectFiltered}>
            {t('af.select_filtered', { n: selectableFilteredCount })}
          </Button>
        </>
      )}
    >
      {actions.map(({ key, icon, label, onClick, isDisabled }) => (isPhone ? (
        <ToolButton key={key} size="sm" variant="ghost" icon={icon} label={label} loading={isRunning(key)} disabled={isMutating || isDisabled} onClick={onClick} />
      ) : (
        <Button key={key} size="sm" variant="ghost" icon={icon} loading={isRunning(key)} disabled={isMutating || isDisabled} onClick={onClick}>
          {label}
        </Button>
      )))}
      <span className="selection-bar-divider" aria-hidden="true" />
      <ConfirmAction
        title={t('af.delete_selected_title')}
        description={deleteDescription}
        confirmLabel={t('common.delete')}
        isDanger
        onConfirm={run('delete', onDelete)}
      >
        {deleteButton}
      </ConfirmAction>
    </SelectionBar>
  );
};
