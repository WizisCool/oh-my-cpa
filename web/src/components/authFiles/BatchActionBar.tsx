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

interface BatchActionBarProps {
  selectedCount: number;
  selectablePageCount: number;
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

  if (selectedCount === 0) {
    return null;
  }

  return (
    <SelectionBar
      label={t('af.selected_n', { n: selectedCount })}
      summary={t('af.selected_n', { n: selectedCount })}
      note={hiddenCount > 0 ? t('omc.hidden_selection', { n: hiddenCount }) : undefined}
      selection={(
        <>
          {selectablePageCount > 0 && (
            <Button size="small" type="link" disabled={isMutating} onClick={onSelectPage}>
              {t('af.select_page')}
            </Button>
          )}
          <Button size="small" type="link" icon={<CloseOutlined />} disabled={isMutating} onClick={onClearSelection}>
            {t('af.clear_selection')}
          </Button>
        </>
      )}
    >
        <Button
          size="small"
          icon={<CheckCircleOutlined />}
          loading={isMutating}
          onClick={onEnable}
        >
          {t('af.batch_enable')}
        </Button>
        <Button
          size="small"
          icon={<StopOutlined />}
          loading={isMutating}
          onClick={onDisable}
        >
          {t('af.batch_disable')}
        </Button>
        <Button
          size="small"
          icon={<SyncOutlined />}
          loading={isMutating}
          disabled={!canRefresh}
          onClick={onRefresh}
        >
          {t('af.batch_refresh')}
        </Button>
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
            danger
            icon={<DeleteOutlined />}
            loading={isMutating}
          >
            {t('af.delete_selected')}
          </Button>
        </ConfirmAction>
    </SelectionBar>
  );
};
