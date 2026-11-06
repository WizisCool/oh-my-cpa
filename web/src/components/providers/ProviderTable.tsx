import React from 'react';
import clsx from 'clsx';
import { App as AntdApp, Button, Dropdown } from 'antd';
import { Switch } from '../common/Switch';
import { PriorityBadge } from '../common/PriorityBadge';
import { GlyphBadge } from '../common/GlyphBadge';
import { BoxOutlined, DeleteOutlined, EditOutlined, KeyOutlined, MoreOutlined, PictureOutlined, RenameOutlined, TagOutlined } from '../icons';
import type { ColumnsType } from 'antd/es/table';

import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { LobeIcon, ProviderMark } from '../LobeIcon';
import { safeExternalURL } from '../../utils/externalUrl';
import { type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { ProviderItem } from '../../types/providers';
import { matchProviderFamily } from '../../types/providerFamilies';
import { successRateTone } from '../../types/usageEventMetrics';
import { ResponsiveList } from '../common/ResponsiveList';
import { StatusLabel } from '../common/StatusLabel';
import styles from './ProviderTable.module.css';
import type { useProviderManagement } from './useProviderManagement';
import {
  providerHeaderCount,
  providerKeyCount,
  providerModelCount,
  type ProviderTraffic,
} from './providerOverview';
import { Tag } from '../common/Tag';
import { ConfirmAction } from '../common/ConfirmAction';
import { Meter } from '../common/Meter';
import { Tooltip } from '../common/Tooltip';
import { InlineNameEditor, inlineNameEditableClass, inlineNamePersistentClass, RenameButton } from '../common/InlineName';
import { RowContextHandle, RowHandleContext, RowReorder, useReorderList, useReorderRow } from '../common/RowReorder';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import type { DropSide } from '../../types/displayOrder';

type ProviderManagement = ReturnType<typeof useProviderManagement>;

interface ProviderTableProps {
  providers: ProviderItem[];
  providersLoading: boolean;
  /** True when the list's read failed with nothing cached, so the page's alert is the one statement. */
  isBlocked?: boolean;
  /** The empty copy: no provider configured, or none matching the filters. */
  emptyText: React.ReactNode;
  /** Each row's traffic over the page's window, by provider id; `undefined` while unknown. */
  traffic: Map<string, ProviderTraffic> | undefined;
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
  /** Names a row in place; resolves whether the name was saved. */
  onRename: ProviderManagement['renameProvider'];
  /** Puts a dragged row beside another; absent until the stored order has been read. */
  onMove?: (key: string, target: string, side: DropSide) => unknown;
}

/**
 * The provider table: one row per credential line, with the enable switch, the
 * brand mark and the actions that open the editor.
 *
 * The columns keep the CPAMC table's order, so an operator moving between the two
 * consoles finds the same facts in the same sequence; the window's traffic, which
 * CPAMC does not show, sits before the state columns it helps explain. It is one component because
 * the switch's rendered state, the row's status label and the icon override the
 * row displays are three readings of the same row that must not disagree.
 */
/*
 * Each column's width where the table first fits beside the sidebar (a 1440px window): what its
 * content needs, plus the cell's 24px of padding. A wider table adds the same width to every
 * column, so the space between any two columns grows together and the row keeps one rhythm instead
 * of a hole wherever the surplus happened to land.
 */
const COLUMN_BASE_WIDTHS = {
  name: 280,
  protocol: 184,
  base_url: 184,
  models_headers: 128,
  traffic: 132,
  status: 72,
  switch: 58,
  actions: 88,
} as const;
type ProviderColumnKey = keyof typeof COLUMN_BASE_WIDTHS;
const COLUMN_BASE_TOTAL = Object.values(COLUMN_BASE_WIDTHS).reduce((sum, width) => sum + width, 0);
const COLUMN_COUNT = Object.keys(COLUMN_BASE_WIDTHS).length;
// The table's own border, which its columns do not get.
const TABLE_FRAME = 2;

/** The element's content width, kept current as the layout changes. */
function useElementWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ProviderTable({
  providers,
  providersLoading,
  isBlocked,
  emptyText,
  traffic,
  providerIcons,
  pluginLogos,
  statusQueue,
  deleteProviderMutation,
  handleOpenEdit,
  setIconPickerOpen,
  setTargetProviderForIcon,
  onRename,
  onMove,
}: ProviderTableProps) {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const { modal } = AntdApp.useApp();
  const [listRef, listWidth] = useElementWidth<HTMLDivElement>();
  const columnSurplus = Math.max(0, Math.floor((listWidth - TABLE_FRAME - COLUMN_BASE_TOTAL) / COLUMN_COUNT));
  const columnWidth = (key: ProviderColumnKey) => COLUMN_BASE_WIDTHS[key] + columnSurplus;
  const reorder = useReorderList(providers, providerKey, (key, target, side) => onMove?.(key, target, side));
  // One row's name is edited at a time, like a credential's on the OAuth page. The editor's name
  // field is a full save that also rewrites CPA's entry; the glyph is the only overlay-only rename,
  // so it stays painted on touch screens and phones.
  const [renamingID, setRenamingID] = React.useState<string | null>(null);
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
  // the two consoles find the same facts in the same sequence; traffic is OMC's own.
  const providerColumns: ColumnsType<ProviderItem> = [
    // 1. icon + display name
    {
      title: t('pro.col_provider'),
      key: 'name',
      // The cell holds the row's edge grip, which is laid over its leading padding.
      className: styles['name-cell'],
      // The width includes the 28px the rename glyph reserves and the priority badge after the name.
      width: columnWidth('name'),
      render: (_, record) => {
        const website = safeExternalURL(record.website);
        // The routing facts under the name: the model prefix and the gateway's own
        // name when the operator renamed the row (request records and CPA's logs carry that name,
        // so it is what a reader cross-checks the row against). The prefix lives here rather than
        // in a column of its own because most rows have none, and a column of "none" was the
        // widest empty space on the page.
        const upstreamName = record.upstream_name && record.upstream_name !== record.name ? record.upstream_name : '';
        const meta = [upstreamName].filter(Boolean);
        const hasMeta = Boolean(record.prefix) || meta.length > 0;
        return (
          <div className={styles['provider-identity']}>
            {!isPhone && <RowContextHandle name={record.name} />}
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
              <ProviderMark provider={record} sources={{ providerIcons, pluginLogos }} size={22} />
            </div>
            <div className={clsx(styles['provider-text'], inlineNameEditableClass, inlineNamePersistentClass)}>
              {renamingID !== record.id && (
                <RenameButton label={record.name} onClick={() => setRenamingID(record.id)} data-testid="provider-rename" />
              )}
              <div className={styles['provider-name']}>
                {renamingID === record.id ? (
                  <InlineNameEditor
                    initial={record.name}
                    label={`${t('pro.field_name')}: ${record.name}`}
                    placeholder={record.upstream_name || t('pro.field_name_ph')}
                    onCommit={async (next) => {
                      const isSaved = await onRename(record, next);
                      if (isSaved) setRenamingID(null);
                      return isSaved;
                    }}
                    onCancel={() => setRenamingID(null)}
                    data-testid="provider-name-input"
                  />
                ) : website ? (
                  // The name is the link when a website is known: the operator's own label is what
                  // they look for on the row, so making it the target avoids a column for one URL.
                  // rel/target keep the destination from reaching back through window.opener.
                  <a href={website} target="_blank" rel="noopener noreferrer">
                    {record.name}
                  </a>
                ) : (
                  record.name
                )}
                {/* The table is wide enough for the priority to follow the name, as the OAuth list's
                    badge does, rather than take a line of its own. */}
                {renamingID !== record.id && Boolean(record.priority) && <PriorityBadge priority={record.priority} />}
              </div>
              {hasMeta && (
                <div className={styles['provider-meta']}>
                  {record.prefix && (
                    <Tooltip title={t('pro.field_prefix')}>
                      <span className={styles['prefix-chip']} aria-label={`${t('pro.field_prefix')}: ${record.prefix}`}>
                        {record.prefix}
                      </span>
                    </Tooltip>
                  )}
                  {meta.length > 0 && <span className={styles['provider-meta-text']}>{meta.join(' · ')}</span>}
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
      // The widest family tag, "Anthropic (Messages)".
      width: columnWidth('protocol'),
      render: (_, record) => {
        const meta = matchProviderFamily(record.family, record.protocol);
        // The transport is the one behaviour switch that changes how requests travel, so the row
        // states it beside the protocol rather than only inside the editor.
        const websocketTag = record.behavior?.websockets ? (
          <Tooltip title={t('policy.websockets_desc')}>
            {/* The mark is text only, so it is not focusable on its own; the row's edit button
                opens the editor where the switch and its explanation live. */}
            <Tag size="small" aria-label={t('policy.websockets_desc')}>{t('pro.websockets_tag')}</Tag>
          </Tooltip>
        ) : null;
        if (!meta) {
          return (
            <div className={styles['protocol']}>
              <Tag className={styles['protocol-tag']}>
                {record.protocol || record.family || t('pro.none_text')}
              </Tag>
              {websocketTag}
            </div>
          );
        }
        // The family's brand colour is data (types/providerFamilies.ts), so it arrives as a custom
        // property and the stylesheet mixes the tint and the border from it.
        return (
          <div className={styles['protocol']}>
            <Tag
              className={`${styles['protocol-tag']} ${styles['protocol-tag-branded']}`}
              style={{ '--family-color': meta.color } as React.CSSProperties}
            >
              <LobeIcon iconId={meta.iconId} size={13} variant="mono" style={{ color: 'var(--family-color)' }} />
              <span>{t(meta.labelKey)}</span>
            </Tag>
            {websocketTag}
          </div>
        );
      },
    },

    // 3. endpoint (truncated when too long)
    {
      title: t('pro.col_endpoint'),
      key: 'base_url',
      // The URL fills the column and ellipsizes past it; its tooltip has it whole.
      width: columnWidth('base_url'),
      render: (_, record) => {
        if (!record.base_url) return <span className={styles['muted']}>{t('pro.none_text')}</span>;
        return (
          <Tooltip title={record.base_url}>
            <div className={styles['endpoint']}>{record.base_url}</div>
          </Tooltip>
        );
      },
    },

    // 4. models / request headers
    {
      title: t('pro.col_models_headers'),
      key: 'models_headers',
      // One line of badges: the models and the keys always, the headers only where any are set, so
      // the base fits all three.
      width: columnWidth('models_headers'),
      render: (_, record) => {
        const modelCount = providerModelCount(record);
        const keyCount = providerKeyCount(record);
        const headerCount = providerHeaderCount(record);
        const modelNames = record.model_entries?.length ? record.model_entries.map((m) => m.name) : record.models ?? [];
        return (
          <div className={styles['count-badges']}>
            <GlyphBadge glyph={<BoxOutlined />} label={t('pro.model_count_pill', { n: modelCount })} items={modelNames}>
              <span>{modelCount}</span>
            </GlyphBadge>
            {/* A switched-on row without a key cannot serve, so its key count is the badge that
                says why the row counts toward "needs attention". */}
            <GlyphBadge
              glyph={<KeyOutlined />}
              label={t('pro.key_count_pill', { n: keyCount })}
              hint={keyCount === 0 ? t('pro.key_missing_hint') : undefined}
              tone={keyCount === 0 ? 'warn' : undefined}
            >
              <span>{keyCount}</span>
            </GlyphBadge>
            {headerCount > 0 && (
              <GlyphBadge glyph={<TagOutlined />} label={t('pro.header_count_pill', { n: headerCount })} items={Object.keys(record.headers ?? {})}>
                <span>{headerCount}</span>
              </GlyphBadge>
            )}
          </div>
        );
      },
    },

    // 5. traffic over the page's window
    {
      title: t('pro.col_traffic'),
      key: 'traffic',
      width: columnWidth('traffic'),
      render: (_, record) => {
        const row = traffic?.get(record.id);
        if (!row) {
          return (
            <Tooltip title={t('pro.traffic_unknown')}>
              <span className={styles['muted']}>—</span>
            </Tooltip>
          );
        }
        if (row.total === 0) return <span className={styles['muted']}>{t('pro.traffic_none')}</span>;
        // The rate's colour is the console's one band (successRateTone), carried by the number as
        // well as by the meter: at a measured 0% the meter has no width to paint.
        const tone = successRateTone(row.successRate);
        const rate = row.successRate ?? 0;
        return (
          <div className={styles['traffic']}>
            <div className={styles['traffic-line']}>
              <span className={styles['traffic-requests']}>{t('pro.traffic_requests', { n: row.total.toLocaleString() })}</span>
              <span className={clsx(styles['traffic-rate'], styles[`tone-${tone}`])}>{`${rate.toFixed(1)}%`}</span>
            </div>
            <Meter className={styles['traffic-meter']} value={rate} color={`var(--${tone === 'neutral' ? 'meta' : tone})`} />
          </div>
        );
      },
    },

    // 6. status
    {
      title: t('pro.col_status'),
      key: 'status',
      width: columnWidth('status'),
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
      width: columnWidth('switch'),
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
      width: columnWidth('actions'),
      align: 'right',
      render: (_, record) => (
        <div className="row-actions">
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              className="row-action-btn"
              icon={<EditOutlined />}
              onClick={() => handleOpenEdit(record)}
              aria-label={`${t('common.edit')}: ${record.name}`}
            />
          </Tooltip>
          <ConfirmAction
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            isDanger
            disabled={isDemo}
            tooltip={isDemo ? t('demo.blocked') : t('common.delete')}
          >
            <Button
              size="small"
              danger
              className="row-action-btn"
              icon={<DeleteOutlined />}
              disabled={isDemo}
              loading={deleteProviderMutation.isPending && deleteProviderMutation.variables === record.id}
              aria-label={`${t('common.delete')}: ${record.name}`}
            />
          </ConfirmAction>
          {isPhone && <RowContextHandle name={record.name} variant="inline" />}
        </div>
      ),
    },
  ];

  /*
   * A provider on a phone, read the way an operator checks one there: is it on, is it healthy,
   * what does it speak and to where. The switch is the card's one control in reach; the card itself
   * opens the editor, and the rarer actions wait behind the menu, so a row is never a strip of
   * glyphs to aim between.
   */
  const renderPhoneCard = (record: ProviderItem, cell: (columnKey: string) => React.ReactNode) => {
    const isEnabled = resolveEnabled(record);
    const row = traffic?.get(record.id);
    const keyCount = providerKeyCount(record);
    const family = matchProviderFamily(record.family, record.protocol);
    const host = endpointHost(record.base_url);
    const tone = successRateTone(row?.successRate);
    const isLowRate = row !== undefined && row.total > 0 && (tone === 'warn' || tone === 'danger');
    // The same verdicts the status tiles count, so a card and the tile it falls under agree.
    const health = !isEnabled
      ? <StatusLabel tone="warn">{t('pro.status_disabled')}</StatusLabel>
      : keyCount === 0
        ? <StatusLabel tone="danger">{t('pro.health_no_key')}</StatusLabel>
        : isLowRate
          ? <StatusLabel tone="danger">{t('pro.stat_attention')}</StatusLabel>
          : <StatusLabel tone="success">{t('pro.status_active')}</StatusLabel>;
    const isRenaming = renamingID === record.id;
    const confirmDelete = () => modal.confirm({
      title: t('pro.delete_provider_confirm'),
      content: record.name,
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => deleteProviderMutation.mutate(record.id),
    });
    const facts = (
      <>
        <span className={styles['phone-card-name-line']}>
          <span className={styles['phone-card-name']}>{record.name}</span>
          {Boolean(record.priority) && <PriorityBadge priority={record.priority} isStatic />}
          {record.prefix && <span className={styles['prefix-chip']}>{record.prefix}</span>}
        </span>
        <span className={styles['phone-card-route']}>
          {family && <LobeIcon iconId={family.iconId} size={12} variant="mono" />}
          <span>{family ? t(family.labelKey) : record.protocol || record.family || t('pro.none_text')}</span>
          {host && <span className={styles['phone-card-host']}>{host}</span>}
          {record.behavior?.websockets && <span>{t('pro.websockets_tag')}</span>}
        </span>
        <span className={styles['phone-card-health']}>
          {health}
          {row && (
            <span className={styles['phone-card-traffic']}>
              {t('pro.window_24h')} {row.total === 0
                ? t('pro.traffic_none')
                : <>
                    {t('pro.traffic_requests', { n: row.total.toLocaleString() })}
                    {' · '}
                    <span className={clsx(isLowRate && styles[`tone-${tone}`])}>{`${(row.successRate ?? 0).toFixed(1)}%`}</span>
                  </>}
            </span>
          )}
        </span>
      </>
    );
    return (
      <article className={styles['phone-card']} data-testid="phone-row" aria-label={record.name}>
        <span className={styles['phone-card-mark']} aria-hidden="true">
          <ProviderMark provider={record} sources={{ providerIcons, pluginLogos }} size={22} />
        </span>
        {isRenaming ? (
          <div className={styles['phone-card-main']}>
            <InlineNameEditor
              initial={record.name}
              label={`${t('pro.field_name')}: ${record.name}`}
              placeholder={record.upstream_name || t('pro.field_name_ph')}
              onCommit={async (next) => {
                const isSaved = await onRename(record, next);
                if (isSaved) setRenamingID(null);
                return isSaved;
              }}
              onCancel={() => setRenamingID(null)}
              data-testid="provider-name-input"
            />
          </div>
        ) : (
          <button
            type="button"
            className={styles['phone-card-main']}
            onClick={() => handleOpenEdit(record)}
            aria-label={`${t('common.edit')}: ${record.name}`}
          >
            {facts}
          </button>
        )}
        <div className={styles['phone-card-switch']}>{cell('switch')}</div>
        <div className={styles['phone-card-tools']}>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'edit', icon: <EditOutlined />, label: t('common.edit') },
                { key: 'rename', icon: <RenameOutlined />, label: t('af.rename') },
                { key: 'icon', icon: <PictureOutlined />, label: t('pro.change_icon') },
                { type: 'divider' as const },
                { key: 'delete', icon: <DeleteOutlined />, label: t('common.delete'), danger: true, disabled: isDemo },
              ],
              onClick: ({ key }) => {
                if (key === 'edit') handleOpenEdit(record);
                else if (key === 'rename') setRenamingID(record.id);
                else if (key === 'icon') openIconPicker(record);
                else if (key === 'delete') confirmDelete();
              },
            }}
          >
            <Button type="text" size="small" className="row-action-btn" icon={<MoreOutlined />} aria-label={`${t('keys.actions_more')}: ${record.name}`} />
          </Dropdown>
          <RowContextHandle name={record.name} variant="inline" />
        </div>
      </article>
    );
  };

  return (
    <div ref={listRef} className={styles['provider-list']}>
      {/* The order is the operator's display order and nothing else: which provider serves a
          request is the routing arrangement's business. */}
      <RowReorder
        items={reorder.ordered.map(providerKey)}
        isEnabled={Boolean(onMove)}
        onMove={reorder.move}
        onStep={reorder.step}
      >
        <ResponsiveList
          columns={providerColumns}
          dataSource={reorder.ordered}
          rowKey="id"
          isLoading={providersLoading}
          isBlocked={isBlocked}
          emptyText={emptyText}
          phone={{ render: renderPhoneCard }}
          tableProps={{ components: REORDERABLE_BODY, tableLayout: 'fixed' }}
          phoneRowWrapper={ReorderablePhoneRow}
        />
      </RowReorder>
    </div>
  );
}

const providerKey = (provider: ProviderItem) => provider.id;

/** The endpoint's host, the part a reader tells two providers apart by; the path is the editor's. */
function endpointHost(baseURL: string | undefined): string {
  if (!baseURL) return '';
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

type BodyRowProps = React.HTMLAttributes<HTMLTableRowElement> & { 'data-row-key'?: React.Key };

/** A data row the operator can hold and move; the table's placeholder rows carry no key and stay put. */
function BodyRow(props: BodyRowProps) {
  const key = props['data-row-key'];
  return key === undefined ? <tr {...props} /> : <ReorderableBodyRow {...props} rowKey={String(key)} />;
}

function ReorderableBodyRow({ rowKey, ...props }: BodyRowProps & { rowKey: string }) {
  const { row, handle } = useReorderRow(rowKey);
  return (
    <RowHandleContext.Provider value={handle}>
      <tr {...props} {...row} />
    </RowHandleContext.Provider>
  );
}

const REORDERABLE_BODY = { body: { row: BodyRow } };

function ReorderablePhoneRow({ rowKey, children }: { rowKey: string; children: React.ReactNode }) {
  const { row, handle } = useReorderRow(rowKey);
  return (
    <RowHandleContext.Provider value={handle}>
      <div {...row}>{children}</div>
    </RowHandleContext.Provider>
  );
}
