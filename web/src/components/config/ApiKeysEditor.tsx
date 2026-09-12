import React from 'react';
import { App as AntdApp, Button, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';

const { Text } = Typography;

interface ApiKeyRecord {
  id: string;
  index: number;
  key: string;
}

export interface ApiKeysEditorProps {
  /** The current key list. The editor never owns it: the caller's draft does. */
  apiKeys: string[];
  /** Replaces the whole list, so the caller stays the single source of truth. */
  onChange: (next: string[]) => void;
  /** Opens the add/edit dialog the caller owns. */
  onAdd: () => void;
  onEdit: (index: number, key: string) => void;
}

/**
 * ApiKeysEditor is the presentational API-key list.
 *
 * It is controlled on purpose. The console persists these keys as part of the
 * visual configuration document, not through the immediate `/management/api-keys`
 * mutations, so the list has to be a view over the caller's draft: an editor that
 * wrote its own state would either diverge from that draft or force a second save
 * path. Add/edit dialogs stay with the caller because they are the part that
 * differs between the configuration workbench and the key-management page.
 */
export const ApiKeysEditor: React.FC<ApiKeysEditorProps> = ({
  apiKeys,
  onChange,
  onAdd,
  onEdit,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [revealedKeys, setRevealedKeys] = React.useState<Record<number, boolean>>({});

  const dataSource: ApiKeyRecord[] = apiKeys.map((key, index) => ({
    id: `${index}-${key}`,
    index,
    key,
  }));

  const handleDelete = (index: number) => {
    onChange(apiKeys.filter((_, position) => position !== index));
    // Reveal state is positional, so a removal would otherwise shift every
    // later key's revealed flag onto the wrong row.
    setRevealedKeys({});
  };

  return (
    <div className="settings-group">
      <div className="settings-group-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyOutlined />
          <h3 className="settings-group-title">{t('cfg.api_keys_list')}</h3>
          <Tag style={{ margin: 0 }}>{t('cfg.api_keys_count', { n: apiKeys.length })}</Tag>
        </div>
        <Button size="small" icon={<PlusOutlined />} onClick={onAdd} className="config-add-key-btn">
          {t('cfg.api_keys_add')}
        </Button>
      </div>
      <Table<ApiKeyRecord>
        className="config-api-keys-table"
        size="small"
        rowKey="id"
        showHeader={false}
        dataSource={dataSource}
        pagination={false}
        locale={{ emptyText: t('cfg.api_keys_empty') }}
        columns={[
          {
            dataIndex: 'index',
            key: 'index',
            width: 70,
            render: (idx: number) => (
              <Text strong className="mono-num">
                #{idx + 1}
              </Text>
            ),
          },
          {
            dataIndex: 'key',
            key: 'key',
            render: (rawKey: string, record: ApiKeyRecord) => (
              <div className="config-key-box">
                <span className="config-key-text">
                  {revealedKeys[record.index] ? rawKey : maskKeyText(rawKey)}
                </span>
              </div>
            ),
          },
          {
            key: 'actions',
            width: 176,
            align: 'right' as const,
            render: (_: unknown, record: ApiKeyRecord) => (
              <Space size={6}>
                <Tooltip
                  title={
                    revealedKeys[record.index]
                      ? t('common.hide_secret')
                      : t('common.reveal_secret')
                  }
                >
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={() =>
                      setRevealedKeys((prev) => ({
                        ...prev,
                        [record.index]: !prev[record.index],
                      }))
                    }
                    aria-label={
                      revealedKeys[record.index]
                        ? t('common.hide_secret')
                        : t('common.reveal_secret')
                    }
                  >
                    {revealedKeys[record.index] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                  </button>
                </Tooltip>
                <Tooltip title={t('cfg.api_keys_copy')}>
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(record.key);
                        message.success(t('cfg.source_copy_success'));
                      } catch {
                        message.error(t('cfg.copy_failed'));
                      }
                    }}
                    aria-label={t('cfg.api_keys_copy')}
                  >
                    <CopyOutlined />
                  </button>
                </Tooltip>
                <Tooltip title={t('cfg.api_keys_edit')}>
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={() => onEdit(record.index, record.key)}
                    aria-label={t('cfg.api_keys_edit')}
                  >
                    <EditOutlined />
                  </button>
                </Tooltip>
                <Popconfirm
                  title={t('cfg.api_keys_delete_confirm')}
                  onConfirm={() => handleDelete(record.index)}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                >
                  <Tooltip title={t('cfg.api_keys_delete')}>
                    <button
                      type="button"
                      className="config-key-action is-danger"
                      aria-label={t('cfg.api_keys_delete')}
                    >
                      <DeleteOutlined />
                    </button>
                  </Tooltip>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
};
