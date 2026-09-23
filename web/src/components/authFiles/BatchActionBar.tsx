import React from 'react';
import { Card, Space, Button, Popconfirm, Typography } from 'antd';
import {
  CheckCircleOutlined,
  StopOutlined,
  DeleteOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';

interface BatchActionBarProps {
  selectedCount: number;
  selectablePageCount: number;
  isMutating: boolean;
  onSelectPage: () => void;
  onClearSelection: () => void;
  onEnable: () => void;
  onDisable: () => void;
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
  onDelete,
  hiddenCount = 0,
}) => {
  const t = useT();

  if (selectedCount === 0) {
    return null;
  }

  return (
    <Card
      size="small"
      style={{
        marginBottom: 16,
        borderColor: 'var(--accent)',
        background: 'var(--surface)',
      }}
      styles={{
        body: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '8px 16px',
        },
      }}
    >
      <Space size={12} wrap>
        <Typography.Text strong>
          {t('af.selected_n', { n: selectedCount })}
        </Typography.Text>
        {hiddenCount > 0 && (
          <Typography.Text type="secondary">
            {t('omc.hidden_selection', { n: hiddenCount })}
          </Typography.Text>
        )}
        {selectablePageCount > 0 && (
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            disabled={isMutating}
            onClick={onSelectPage}
          >
            {t('af.select_page')}
          </Button>
        )}
        <Button
          size="small"
          type="link"
          icon={<CloseOutlined />}
          style={{ padding: 0, color: 'var(--muted)' }}
          disabled={isMutating}
          onClick={onClearSelection}
        >
          {t('af.clear_selection')}
        </Button>
      </Space>

      <Space size={8} wrap>
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
        <Popconfirm
          title={t('af.delete_selected_title')}
          description={hiddenCount > 0
            ? `${t('af.delete_selected_desc')} ${t('omc.delete_hidden_scope', { hidden: hiddenCount, total: selectedCount })}`
            : t('af.delete_selected_desc')}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
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
        </Popconfirm>
      </Space>
    </Card>
  );
};
