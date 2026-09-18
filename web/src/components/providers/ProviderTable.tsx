import { Button, Card, Popconfirm, Switch, Table, Tag, Tooltip } from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import { useT } from '../../i18n';
import { getProviderDefaultIcon, LobeIcon } from '../LobeIcon';
import { maskKeyText } from '../../utils/maskKey';
import { safeExternalURL } from '../../utils/externalUrl';
import { resolveProviderIcon } from '../../types/providerIcons';
import type { ProviderItem } from '../../types/providers';
import { matchProviderFamily } from '../../types/providerFamilies';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { PhoneRow } from '../common/PhoneRow';
import { phoneRowFields, renderedCell } from '../common/phoneRowFields';
import type { useProviderManagement } from './useProviderManagement';

type ProviderManagement = ReturnType<typeof useProviderManagement>;

interface ProviderTableProps {
  providers: ProviderItem[];
  providersLoading: boolean;
  providerIcons: Record<string, string>;
  statusQueue: ProviderManagement['statusQueue'];
  deleteProviderMutation: ProviderManagement['deleteProviderMutation'];
  /** Opens the editor on the row the operator clicked. */
  handleOpenEdit: (provider: ProviderItem) => void;
  /** Opens the brand-mark picker for a row, rather than for the form. */
  setIconPickerOpen: ProviderManagement['setIconPickerOpen'];
  setTargetProviderForIcon: ProviderManagement['setTargetProviderForIcon'];

}

/**
 * The provider table: one row per credential line, with the enable switch, the
 * brand mark and the actions that open the editor.
 *
 * The column set is the CPAMC table's order, so an operator moving between the two
 * consoles finds the same facts in the same sequence. It is one component because
 * the switch's rendered state, the row's status label and the icon override the
 * row displays are three readings of the same row that must not disagree.
 */
export function ProviderTable({
  providers,
  providersLoading,
  providerIcons,
  statusQueue,
  deleteProviderMutation,
  handleOpenEdit,
  setIconPickerOpen,
  setTargetProviderForIcon,
}: ProviderTableProps) {
  const t = useT();

  // ── Shared helpers ────────────────────────────────────────────────────────
  /**
   * resolveEnabled is the row's single answer to "is this provider on?".
   *
   * The status label and the switch both render it, so a burst can never leave
   * one saying on and the other off: the intent wins while the queue is working,
   * and the gateway's own value is the answer at rest.
   */
  const resolveEnabled = (record: ProviderItem): boolean => {
    const target = statusQueue.targetFor(record.id);
    return target === undefined ? !record.disabled : target;
  };

  // Column order mirrors the CPAMC provider table so operators moving between
  // the two consoles find the same facts in the same sequence.
  const providerColumns: ColumnsType<ProviderItem> = [
    // 1. icon + display name
    {
      title: t('pro.col_provider'),
      key: 'name',
      render: (_, record) => {
        const iconId = resolveProviderIcon(
          providerIcons,
          record,
          getProviderDefaultIcon(record.family, record.name, record.base_url),
        );
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              title={t('pro.change_icon')}
              onClick={() => {
                setTargetProviderForIcon(record);
                setIconPickerOpen(true);
              }}
            >
              <LobeIcon iconId={iconId} size={22} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
                {safeExternalURL(record.website) ? (
                  // The name is the link when a website is known: the operator's
                  // own label is what they look for on the row, so making it the
                  // target avoids a column for one URL. rel/target keep the
                  // destination from reaching back through window.opener.
                  <a
                    href={safeExternalURL(record.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    {record.name}
                  </a>
                ) : (
                  record.name
                )}
              </div>
              {record.api_key && (
                <div
                  title={record.api_key}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: 'var(--meta)',
                    marginTop: 2,
                    maxWidth: 220,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {maskKeyText(record.api_key)}
                </div>
              )}
            </div>
          </div>
        );
      },
    },

    // 2. protocol driver
    {
      title: t('pro.col_protocol'),
      key: 'protocol',
      render: (_, record) => {
        const meta = matchProviderFamily(record.family, record.protocol);
        if (!meta) {
          return (
            <Tag style={{ margin: 0 }}>
              {record.protocol || record.family || t('pro.none_text')}
            </Tag>
          );
        }
        return (
          <Tag
            style={{
              margin: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px',
              borderRadius: 4,
              color: meta.color,
              borderColor: `${meta.color}66`,
              backgroundColor: `${meta.color}18`,
              fontWeight: 500,
              fontSize: 12,
              lineHeight: '18px',
            }}
          >
            <LobeIcon
              iconId={meta.iconId}
              size={13}
              variant="mono"
              style={{ color: meta.color, flexShrink: 0, display: 'inline-flex' }}
            />
            <span>{t(meta.labelKey)}</span>
          </Tag>
        );
      },
    },

    // 3. endpoint (truncated when too long)
    {
      title: t('pro.col_endpoint'),
      key: 'base_url',
      render: (_, record) => {
        if (!record.base_url) return <span style={{ color: 'var(--meta)' }}>{t('pro.none_text')}</span>;
        return (
          <Tooltip title={record.base_url}>
            <div
              style={{
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'var(--fg)',
              }}
            >
              {record.base_url}
            </div>
          </Tooltip>
        );
      },
    },

    // 4. prefix (shows "none" when absent)
    {
      title: t('pro.field_prefix'),
      key: 'prefix',
      render: (_, record) =>
        record.prefix ? (
          <Tag color="geekblue" style={{ fontFamily: 'monospace', margin: 0, borderRadius: 'var(--radius-sm, 4px)' }}>
            {record.prefix}
          </Tag>
        ) : (
          <span style={{ color: 'var(--meta)', fontSize: 13 }}>{t('pro.none_text')}</span>
        ),
    },

    // 5. models / request headers
    {
      title: t('pro.col_models_headers'),
      key: 'models_headers',
      render: (_, record) => {
        const modelCount = record.model_entries?.length || record.models?.length || 0;
        const keyCount = record.key_entries?.length || (record.key_configured ? 1 : 0);
        const headerCount = record.headers ? Object.keys(record.headers).length : 0;
        const modelNames =
          record.model_entries?.map((m) => m.name).join(', ') ||
          record.models?.join(', ') ||
          '';

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Tooltip title={modelNames || undefined}>
                <Tag
                  style={{
                    borderRadius: 'var(--radius-sm, 4px)',
                    fontSize: 11,
                    margin: 0,
                    padding: '0 8px',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {t('pro.model_count_pill', { n: modelCount })}
                </Tag>
              </Tooltip>
              <Tag
                style={{
                  borderRadius: 'var(--radius-sm, 4px)',
                  fontSize: 11,
                  margin: 0,
                  padding: '0 8px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('pro.key_count_pill', { n: keyCount })}
              </Tag>
            </div>
            <div>
              <Tag
                style={{
                  borderRadius: 'var(--radius-sm, 4px)',
                  fontSize: 11,
                  margin: 0,
                  padding: '0 8px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('pro.header_count_pill', { n: headerCount })}
              </Tag>
            </div>
          </div>
        );
      },
    },

    // 6. status
    {
      title: t('pro.col_status'),
      key: 'status',
      width: 100,
      render: (_, record) => {
        // Read through the same resolution the switch uses. During a burst the
        // row shows the operator's newest intent in both places, so the label
        // and the control can never contradict each other on the same line while
        // the gateway catches up.
        const isEnabled = resolveEnabled(record);
        return isEnabled ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--success)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text)' }}>{t('pro.status_active')}</span>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--warn)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text-muted)' }}>{t('pro.status_disabled')}</span>
          </span>
        );
      },
    },

    // 7. enable switch
    {
      title: t('pro.col_switch'),
      key: 'switch',
      width: 70,
      render: (_, record) => {
        // The switch shows the operator's newest intent while a toggle is in
        // flight, so a second click is visible immediately instead of the row
        // flicking back to the state the server has not updated yet. Do not use
        // antd's loading prop here: it forces the switch disabled and swallows
        // the rapid reversal the queue exists to preserve. Keep the pending
        // state available to assistive tech without blocking input.
        return (
          <Switch
            size="small"
            checked={resolveEnabled(record)}
            aria-busy={statusQueue.isBusy(record.id)}
            aria-label={`${t('pro.col_switch')}: ${record.name}`}
            onChange={(checked) => statusQueue.request(record.id, checked)}
          />
        );
      },
    },

    // 8. row actions
    {
      title: t('common.actions'),
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, record) => (
        /* An 8px gap rather than 4: 28px controls 8px apart leave the touch rules' expanded hit
           areas meeting exactly instead of overlapping by 4px, and three of them still fit the
           110px column. */
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Tooltip title={t('common.details')}>
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => handleOpenEdit(record)}
              aria-label={`${t('common.details')}: ${record.name}`}
              style={{
                width: 28,
                height: 28,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-sm, 4px)',
                borderColor: 'var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-muted)',
              }}
            />
          </Tooltip>
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleOpenEdit(record)}
              aria-label={`${t('common.edit')}: ${record.name}`}
              style={{
                width: 28,
                height: 28,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-sm, 4px)',
                borderColor: 'var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-muted)',
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Tooltip title={t('common.delete')}>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={deleteProviderMutation.isPending && deleteProviderMutation.variables === record.id}
                aria-label={`${t('common.delete')}: ${record.name}`}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius-sm, 4px)',
                  borderColor: 'var(--border)',
                  background: 'var(--surface)',
                }}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      ),
    },
  ];

  // Below 640px each credential line becomes a row (ADR 0012). Both renderings read the same
  // `providerColumns`, so the fields are the table's own columns in the table's own order with
  // the table's own labels, and the switch and the action cluster are the columns' own rendered
  // cells rather than a second copy of them.
  const isPhone = useIsPhoneViewport();

  return (
    <Card>
      {isPhone ? (
        providers.length === 0 ? (
          <p className="empty-copy">{t('pro.providers_empty')}</p>
        ) : (
          <div>
            {providers.map((record, index) => (
              <PhoneRow
                key={record.id}
                identity={renderedCell(providerColumns, 'name', record, index)}
                fields={phoneRowFields(providerColumns, record, {
                  // The name is the headline, and the state, the switch and the actions are the
                  // row's control strip - printing them twice would make the row read as if it
                  // had two states that could disagree.
                  skip: ['name', 'status', 'switch', 'actions'],
                  index,
                })}
                actions={
                  <>
                    {renderedCell(providerColumns, 'status', record, index)}
                    {renderedCell(providerColumns, 'switch', record, index)}
                    {renderedCell(providerColumns, 'actions', record, index)}
                  </>
                }
              />
            ))}
          </div>
        )
      ) : (
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table
            columns={providerColumns}
            dataSource={providers}
            rowKey="id"
            loading={providersLoading}
            pagination={false}
            locale={{ emptyText: t('pro.providers_empty') }}
          />
        </div>
      )}
    </Card>
  );
}
