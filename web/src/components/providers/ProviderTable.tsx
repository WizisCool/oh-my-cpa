import type React from 'react';
import { Button, Popconfirm, Switch, Tag, Tooltip } from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined } from '../icons';
import type { ColumnsType } from 'antd/es/table';

import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { getProviderDefaultIcon, LobeIcon, ProviderBrandIcon } from '../LobeIcon';
import { safeExternalURL } from '../../utils/externalUrl';
import { resolveProviderIcon } from '../../types/providerIcons';
import { pluginOAuthLogoFor, type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { ProviderItem } from '../../types/providers';
import { matchProviderFamily } from '../../types/providerFamilies';
import { ResponsiveList } from '../common/ResponsiveList';
import { StatusLabel } from '../common/StatusLabel';
import styles from './ProviderTable.module.css';
import type { useProviderManagement } from './useProviderManagement';

type ProviderManagement = ReturnType<typeof useProviderManagement>;

interface ProviderTableProps {
  providers: ProviderItem[];
  providersLoading: boolean;
  providerIcons: Record<string, string>;
  /** Logos published by installed plugins, keyed by the OAuth provider they register. */
  pluginLogos?: PluginOAuthLogos;
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
  pluginLogos,
  statusQueue,
  deleteProviderMutation,
  handleOpenEdit,
  setIconPickerOpen,
  setTargetProviderForIcon,
}: ProviderTableProps) {
  const t = useT();
  // Provider definitions live in the gateway's configuration, so creating, editing,
  // enabling and deleting one are all refused by the demonstration.
  const isDemo = isDemoMode();

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

  const openIconPicker = (record: ProviderItem) => {
    setTargetProviderForIcon(record);
    setIconPickerOpen(true);
  };

  // Column order mirrors the CPAMC provider table so operators moving between
  // the two consoles find the same facts in the same sequence.
  const providerColumns: ColumnsType<ProviderItem> = [
    // 1. icon + display name
    {
      title: t('pro.col_provider'),
      key: 'name',
      // The name is the row's identity: auto layout otherwise hands its width to the endpoint
      // and breaks "Anthropic Claude" one syllable per line.
      minWidth: 200,
      render: (_, record) => {
        const iconId = resolveProviderIcon(
          providerIcons,
          record,
          getProviderDefaultIcon(record.family, record.name, record.base_url),
        );
        // A plugin that registers this provider publishes the mark to use; a stored
        // icon preference cannot outrank it, because the console does not own that
        // provider's identity.
        const pluginLogo = pluginOAuthLogoFor(pluginLogos, record.family)
          ?? pluginOAuthLogoFor(pluginLogos, record.upstream_name)
          ?? pluginOAuthLogoFor(pluginLogos, record.name)
          ?? pluginOAuthLogoFor(pluginLogos, record.id);
        const website = safeExternalURL(record.website);
        return (
          <div className={styles['provider-identity']}>
            <div
              className={styles['provider-mark']}
              title={t('pro.change_icon')}
              role="button"
              tabIndex={0}
              aria-label={`${t('pro.change_icon')}: ${record.name}`}
              onClick={() => openIconPicker(record)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openIconPicker(record);
                }
              }}
            >
              <ProviderBrandIcon iconId={iconId} logo={pluginLogo} size={22} />
            </div>
            <div className={styles['provider-name']}>
              {website ? (
                // The name is the link when a website is known: the operator's own label is what
                // they look for on the row, so making it the target avoids a column for one URL.
                // rel/target keep the destination from reaching back through window.opener.
                <a href={website} target="_blank" rel="noopener noreferrer">
                  {record.name}
                </a>
              ) : (
                record.name
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
            <Tag className={styles['protocol-tag']}>
              {record.protocol || record.family || t('pro.none_text')}
            </Tag>
          );
        }
        // The family's brand colour is data (types/providerFamilies.ts), so it arrives as a custom
        // property and the stylesheet mixes the tint and the border from it.
        return (
          <Tag
            className={`${styles['protocol-tag']} ${styles['protocol-tag-branded']}`}
            style={{ '--family-color': meta.color } as React.CSSProperties}
          >
            <LobeIcon iconId={meta.iconId} size={13} variant="mono" style={{ color: 'var(--family-color)' }} />
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
        if (!record.base_url) return <span className={styles['muted']}>{t('pro.none_text')}</span>;
        return (
          <Tooltip title={record.base_url}>
            <div className={styles['endpoint']}>{record.base_url}</div>
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
          <span className={styles['prefix-chip']}>{record.prefix}</span>
        ) : (
          <span className={styles['muted']}>{t('pro.none_text')}</span>
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
          <div className={styles['count-pills']}>
            <Tooltip title={modelNames || undefined}>
              <span className={styles['count-pill']}>{t('pro.model_count_pill', { n: modelCount })}</span>
            </Tooltip>
            <span className={styles['count-pill']}>{t('pro.key_count_pill', { n: keyCount })}</span>
            <span className={styles['count-pill']}>{t('pro.header_count_pill', { n: headerCount })}</span>
          </div>
        );
      },
    },

    // 6. status
    {
      title: t('pro.col_status'),
      key: 'status',
      width: 96,
      // Read through the same resolution the switch uses. During a burst the row shows the
      // operator's newest intent in both places, so the label and the control can never
      // contradict each other on the same line while the gateway catches up.
      render: (_, record) => (resolveEnabled(record)
        ? <StatusLabel tone="success">{t('pro.status_active')}</StatusLabel>
        : <StatusLabel tone="warn">{t('pro.status_disabled')}</StatusLabel>),
    },

    // 7. enable switch
    {
      title: t('pro.col_switch'),
      key: 'switch',
      width: 72,
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
            // Enabling or disabling a provider writes the gateway's own configuration,
            // which the demonstration refuses.
            disabled={isDemo}
            onChange={(checked) => statusQueue.request(record.id, checked)}
          />
        );
      },
    },

    // 8. row actions
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_, record) => (
        <div className="row-actions">
          <Tooltip title={t('common.details')}>
            <Button
              size="small"
              className="row-action-btn"
              icon={<EyeOutlined />}
              onClick={() => handleOpenEdit(record)}
              aria-label={`${t('common.details')}: ${record.name}`}
            />
          </Tooltip>
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              className="row-action-btn"
              icon={<EditOutlined />}
              onClick={() => handleOpenEdit(record)}
              aria-label={`${t('common.edit')}: ${record.name}`}
            />
          </Tooltip>
          <Popconfirm
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            disabled={isDemo}
          >
            <Tooltip title={isDemo ? t('demo.blocked') : t('common.delete')}>
              <Button
                size="small"
                danger
                className="row-action-btn"
                icon={<DeleteOutlined />}
                disabled={isDemo}
                loading={deleteProviderMutation.isPending && deleteProviderMutation.variables === record.id}
                aria-label={`${t('common.delete')}: ${record.name}`}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      ),
    },
  ];

  // Below 640px each credential line becomes a row (ADR 0012). The name is the headline, and the
  // state, the switch and the actions are the row's control strip - printing them twice would make
  // the row read as if it had two states that could disagree.
  return (
    <ResponsiveList
      columns={providerColumns}
      dataSource={providers}
      rowKey="id"
      isLoading={providersLoading}
      emptyText={t('pro.providers_empty')}
      phone={{ identity: 'name', actions: ['status', 'switch', 'actions'] }}
    />
  );
}
