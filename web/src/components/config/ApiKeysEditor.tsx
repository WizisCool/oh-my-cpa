import React from 'react';
import { App as AntdApp, Button, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  PlusOutlined,
  SearchOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import type { ClientAPIKeyItem, ClientKeyUsageItem } from '../../types/providers';

const { Text } = Typography;

/** One rendered row: the CPA key itself plus the identity and traffic Oh My CPA
 *  knows about it. A key CPA reports but the console has never seen traffic from
 *  still gets a row - it is configured, just unused. */
export interface ApiKeyRecord {
  id: string;
  index: number;
  key: string;
  /** Usage records identity, absent when it could not be computed. */
  usageFingerprint?: string;
  alias?: string;
  aliasVersion: number;
  usage?: ClientKeyUsageItem;
}

export interface ApiKeysEditorProps {
  /** The current key list. The editor never owns it: the caller's draft does. */
  apiKeys: string[];
  /** The stored keys and their aliases, keyed by position in `apiKeys`. */
  metadata?: ClientAPIKeyItem[];
  /** Keyed by usage fingerprint. */
  usage?: Record<string, ClientKeyUsageItem>;
  /**
   * Formats a timestamp for the last-used cell. Injected so the page renders it
   * through the same format the request list prints, so a key's last use and the
   * request row it links to cannot disagree about what a time looks like.
   */
  formatTime: (ms: number) => string;
  /** The window the usage counts describe, for the scope note. */
  usageRangeLabel: string;
  /** Replaces the whole list, so the caller stays the single source of truth. */
  onChange: (next: string[]) => void;
  /** Opens the add/edit dialog the caller owns. */
  onAdd: () => void;
  onEdit: (index: number, key: string) => void;
  /** Saves one alias. The caller owns the request and its conflict handling. */
  onRename: (record: ApiKeyRecord, alias: string) => Promise<void>;
  /** Navigates to the request console filtered by this key's identity. */
  onViewRequests: (record: ApiKeyRecord) => void;
}

/**
 * ApiKeysEditor is the presentational API-key table.
 *
 * It is controlled on purpose. The console persists these keys as part of the
 * visual configuration document, not through the immediate `/management/api-keys`
 * mutations, so the list has to be a view over the caller's draft: an editor that
 * wrote its own state would either diverge from that draft or force a second save
 * path. Add/edit dialogs stay with the caller because they are the part that
 * differs between the configuration workbench and the key-management page.
 *
 * Aliases are the exception, and deliberately so. A name is Oh My CPA metadata,
 * not CPA configuration, so it is saved immediately through its own endpoint
 * instead of joining the draft. Putting it in the draft would mean naming a key
 * rewrote CPA's `api-keys` list and rotated the configuration revision for every
 * other editor.
 */
export const ApiKeysEditor: React.FC<ApiKeysEditorProps> = ({
  apiKeys,
  metadata,
  usage,
  formatTime,
  usageRangeLabel,
  onChange,
  onAdd,
  onEdit,
  onRename,
  onViewRequests,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [revealedKeys, setRevealedKeys] = React.useState<Record<number, boolean>>({});
  const [renaming, setRenaming] = React.useState<ApiKeyRecord | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [isSavingName, setIsSavingName] = React.useState(false);

  // Metadata is joined by position because CPA's list and Oh My CPA's overlay are
  // both ordered by the same document. The identity that actually matters - the
  // fingerprint an alias is stored against - travels inside each entry, so a
  // misalignment could only ever mislabel a row, never rename another key's
  // history.
  const dataSource: ApiKeyRecord[] = apiKeys.map((key, index) => {
    const entry = metadata?.[index];
    // A key that was edited in the draft no longer matches its stored entry, so
    // its alias is dropped rather than shown against a value it does not belong
    // to. The alias returns once the draft is saved and reloaded.
    const matchesStored = entry !== undefined && entry.key === key;
    const usageFingerprint = matchesStored ? entry.usage_fingerprint : undefined;
    return {
      id: `${index}-${key}`,
      index,
      key,
      usageFingerprint,
      alias: matchesStored ? entry.alias : undefined,
      aliasVersion: matchesStored ? entry.alias_version : 0,
      usage: usageFingerprint ? usage?.[usageFingerprint] : undefined,
    };
  });

  const handleDelete = (index: number) => {
    onChange(apiKeys.filter((_, position) => position !== index));
    // Reveal state is positional, so a removal would otherwise shift every
    // later key's revealed flag onto the wrong row.
    setRevealedKeys({});
  };

  const openRename = (record: ApiKeyRecord) => {
    setRenaming(record);
    setRenameValue(record.alias ?? '');
  };

  const submitRename = async () => {
    if (!renaming) return;
    setIsSavingName(true);
    try {
      await onRename(renaming, renameValue.trim());
      setRenaming(null);
      setRenameValue('');
    } catch {
      // The caller reports the failure; the dialog stays open so the operator
      // does not lose what they typed.
    } finally {
      setIsSavingName(false);
    }
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
        dataSource={dataSource}
        pagination={false}
        locale={{ emptyText: t('cfg.api_keys_empty') }}
        columns={[
          {
            title: t('keys.col_name'),
            key: 'name',
            render: (_: unknown, record: ApiKeyRecord) =>
              record.alias ? (
                <Text strong>{record.alias}</Text>
              ) : (
                <Text type="secondary">{t('keys.unnamed')}</Text>
              ),
          },
          {
            title: t('keys.col_key'),
            key: 'key',
            render: (_: unknown, record: ApiKeyRecord) => (
              <div className="config-key-box">
                <span className="config-key-text">
                  {revealedKeys[record.index] ? record.key : maskKeyText(record.key)}
                </span>
              </div>
            ),
          },
          {
            title: t('keys.col_requests'),
            key: 'requests',
            width: 110,
            render: (_: unknown, record: ApiKeyRecord) =>
              record.usage ? (
                <Text className="mono-num">{record.usage.requests.toLocaleString()}</Text>
              ) : (
                // Distinguishes "configured but never seen" from a real zero: the
                // counts describe this console's stored records, not the key's
                // whole life, so an unlinked key is stated rather than shown as 0.
                <Tooltip title={t('keys.not_linked')}>
                  <Text type="secondary">—</Text>
                </Tooltip>
              ),
          },
          {
            title: t('keys.col_last_used'),
            key: 'lastUsed',
            width: 150,
            render: (_: unknown, record: ApiKeyRecord) =>
              record.usage && record.usage.last_used_ms > 0 ? (
                <time dateTime={new Date(record.usage.last_used_ms).toISOString()}>
                  <Text type="secondary">{formatTime(record.usage.last_used_ms)}</Text>
                </time>
              ) : (
                <Text type="secondary">—</Text>
              ),
          },
          {
            title: t('keys.col_actions'),
            key: 'actions',
            width: 210,
            align: 'right' as const,
            render: (_: unknown, record: ApiKeyRecord) => (
              <Space size={6}>
                <Tooltip title={t('keys.rename')}>
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={() => openRename(record)}
                    aria-label={`${t('keys.rename')}: ${record.alias ?? t('keys.unnamed')}`}
                  >
                    <TagOutlined />
                  </button>
                </Tooltip>
                <Tooltip
                  title={
                    record.usageFingerprint
                      ? t('keys.view_requests')
                      : t('keys.not_linked')
                  }
                >
                  <button
                    type="button"
                    className="config-key-action"
                    // Disabled rather than hidden: the identity is what makes the
                    // action possible, and its absence is worth seeing.
                    disabled={!record.usageFingerprint}
                    onClick={() => onViewRequests(record)}
                    aria-label={`${t('keys.view_requests')}: ${record.alias ?? t('keys.unnamed')}`}
                  >
                    <SearchOutlined />
                  </button>
                </Tooltip>
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
      {apiKeys.length > 0 && (
        <p className="config-keys-scope-note">
          <Text type="secondary">{t('keys.usage_scope', { range: usageRangeLabel })}</Text>
        </p>
      )}

      <Modal
        title={t('keys.rename_title')}
        open={renaming !== null}
        onOk={() => void submitRename()}
        confirmLoading={isSavingName}
        onCancel={() => {
          setRenaming(null);
          setRenameValue('');
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onPressEnter={() => void submitRename()}
            placeholder={t('keys.rename_placeholder')}
            maxLength={64}
            autoFocus
            aria-label={t('keys.rename_label')}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('keys.rename_hint')}
          </Text>
        </div>
      </Modal>
    </div>
  );
};
