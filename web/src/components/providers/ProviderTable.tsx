import React from 'react';
import { MetaLine } from '../common/MetaLine';
import clsx from 'clsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfirmModal } from '../feedback';
import { Button } from '@/components/ui/button';
import { Switch } from '../common/Switch';
import { PriorityBadge } from '../common/PriorityBadge';
import { GlyphBadge } from '../common/GlyphBadge';
import { BoxOutlined, DeleteOutlined, EditOutlined, ExternalLinkOutlined, KeyOutlined, MoreOutlined, PictureOutlined, RenameOutlined, TagOutlined } from '../icons';
import type { ColumnsType } from '@/components/ui/table';

import { useT } from '../../i18n';
import { LobeIcon, ProviderMark } from '../LobeIcon';
import { safeExternalURL } from '../../utils/externalUrl';
import { type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { ProviderItem } from '../../types/providers';
import { matchProviderFamily } from '../../types/providerFamilies';
import { successRateTone } from '../../types/usageEventMetrics';
import { ResponsiveList } from '../common/ResponsiveList';
import { StatusLabel } from '../common/StatusLabel';
import { TrafficCell } from '../common/TrafficCell';
import styles from './ProviderTable.module.css';
import type { useProviderManagement } from './useProviderManagement';
import {
  providerCallPoints,
  providerHeaderCount,
  providerKeyCount,
  type ProviderTraffic,
} from './providerOverview';
import { Tag } from '../common/Tag';
import { ConfirmAction } from '../common/ConfirmAction';
import { Tooltip } from '../common/Tooltip';
import { InlineNameEditor, inlineNameEditableClass, inlineNamePersistentClass, RenameButton } from '../common/InlineName';
import { RowContextHandle, RowHandleContext, RowReorder, useReorderList, useReorderRow } from '../common/RowReorder';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import type { DropSide } from '../../types/displayOrder';
import { useFilterItemMotion } from '../../motion/filter';
import { m } from '../../motion';

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
  toggleProviderStatus: ProviderManagement['toggleProviderStatus'];
  busyProviderIds: ProviderManagement['busyProviderIds'];
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
  toggleProviderStatus,
  busyProviderIds,
  deleteProviderMutation,
  handleOpenEdit,
  setIconPickerOpen,
  setTargetProviderForIcon,
  onRename,
  onMove,
}: ProviderTableProps) {
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const modal = useConfirmModal();
  const [listRef, listWidth] = useElementWidth<HTMLDivElement>();
  const columnSurplus = Math.max(0, Math.floor((listWidth - TABLE_FRAME - COLUMN_BASE_TOTAL) / COLUMN_COUNT));
  const columnWidth = (key: ProviderColumnKey) => COLUMN_BASE_WIDTHS[key] + columnSurplus;
  const reorder = useReorderList(providers, providerKey, (key, target, side) => onMove?.(key, target, side));
  // One row's name is edited at a time, like a credential's on the OAuth page. The editor's name
  // field is a full save that also rewrites CPA's entry; the glyph is the only overlay-only rename,
  // so it stays painted on touch screens and phones.
  const [renamingID, setRenamingID] = React.useState<string | null>(null);

  // ── Shared helpers ────────────────────────────────────────────────────────
  /**
   * resolveEnabled is the row's single answer to "is this provider on?".
   *
   * The status label and the switch both render it, so a burst can never leave
   * one saying on and the other off: the intent wins while the queue is working,
   * and the gateway's own value is the answer at rest.
   */
  const resolveEnabled = (record: ProviderItem): boolean => !record.disabled;

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
        const hasMeta = Boolean(record.prefix) || Boolean(upstreamName);
        return (
          <div className={styles['provider-identity']}>
            {!isPhone && <RowContextHandle name={record.name} />}
            <div
              className={styles['provider-mark']}
              data-tip={t('pro.change_icon')}
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
                {renamingID !== record.id && (
                  <RenameButton label={record.name} onClick={() => setRenamingID(record.id)} data-testid="provider-rename" />
                )}
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
                  {upstreamName && <span className={styles['provider-meta-text']}>{upstreamName}</span>}
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
          <div className={styles['endpoint']} data-tip={record.base_url} data-tip-overflow="">{record.base_url}</div>
        );
      },
    },

    // 4. models / request headers
    {
      title: t('pro.col_models_headers'),
      key: 'models_headers',
      // The models and the keys always, the headers only where any are set. The base fits all three
      // on one line; counts too long for it wrap rather than run into the traffic column.
      width: columnWidth('models_headers'),
      render: (_, record) => {
        // The badge counts what the row publishes, so a model behind an alias is listed as the alias
        // a client requests; the request model follows it, because that is what the alias maps onto.
        const callPoints = providerCallPoints(record);
        const keyCount = providerKeyCount(record);
        const headerCount = providerHeaderCount(record);
        const callPointNames = callPoints.map(({ name, upstream }) => (upstream ? `${name} ← ${upstream}` : name));
        return (
          <div className={styles['count-badges']}>
            <GlyphBadge glyph={<BoxOutlined />} label={t('pro.model_count_pill', { n: callPoints.length })} items={callPointNames}>
              <span>{callPoints.length}</span>
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
      render: (_, record) => <TrafficCell traffic={traffic?.get(record.id)} />,
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
            aria-busy={busyProviderIds.has(record.id)}
            aria-label={`${t('pro.col_switch')}: ${record.name}`}
            onChange={(checked) => toggleProviderStatus(record.id, checked)}
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
              size="sm"
              variant="ghost" className="row-action-btn"
              icon={<EditOutlined />}
              onClick={() => handleOpenEdit(record)}
              aria-label={`${t('common.edit')}: ${record.name}`}
            />
          </Tooltip>
          <ConfirmAction
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            isDanger
            tooltip={t('common.delete')}
          >
            <Button
              size="sm"
              danger
              variant="ghost" className="row-action-btn"
              icon={<DeleteOutlined />}
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
    const website = safeExternalURL(record.website);
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
          <span className={styles['phone-card-family']}>
            {family && <LobeIcon iconId={family.iconId} size={12} variant="mono" />}
            <span>{family ? t(family.labelKey) : record.protocol || record.family || t('pro.none_text')}</span>
          </span>
          {host && <span className={styles['phone-card-host']}>{host}</span>}
          {record.behavior?.websockets && <span>{t('pro.websockets_tag')}</span>}
        </span>
        <span className={styles['phone-card-health']}>
          {health}
          {row && (
            <span className={styles['phone-card-traffic']}>
              <MetaLine>
                {t('pro.window_24h')}
                {row.total === 0 ? t('pro.traffic_none') : t('pro.traffic_requests', { n: row.total.toLocaleString() })}
                {row.total > 0 && <span className={clsx(isLowRate && styles[`tone-${tone}`])}>{`${(row.successRate ?? 0).toFixed(1)}%`}</span>}
              </MetaLine>
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
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="sm" className="row-action-btn" icon={<MoreOutlined />} aria-label={`${t('keys.actions_more')}: ${record.name}`} />
              }
            />
            <DropdownMenuContent placement="bottomRight">
              <DropdownMenuItem icon={<EditOutlined />} onClick={() => handleOpenEdit(record)}>
                {t('common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem icon={<RenameOutlined />} onClick={() => setRenamingID(record.id)}>
                {t('af.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem icon={<PictureOutlined />} onClick={() => openIconPicker(record)}>
                {t('pro.change_icon')}
              </DropdownMenuItem>
              {website && (
                <DropdownMenuItem
                  icon={<ExternalLinkOutlined />}
                  render={<a href={website} target="_blank" rel="noopener noreferrer" />}
                >
                  {t('pro.field_website')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<DeleteOutlined />} danger onClick={confirmDelete}>
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
          isFilterAnimated
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

type BodyRowProps = Omit<React.HTMLAttributes<HTMLTableRowElement>,
  // Motion owns these handlers; the row's own drag is dnd-kit's, not the DOM's.
  'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd' | 'onAnimationIteration'> & { 'data-row-key'?: React.Key };

/** A data row the operator can hold and move; the table's placeholder rows carry no key and stay put. */
function BodyRow(props: BodyRowProps) {
  const key = props['data-row-key'];
  return key === undefined ? <tr {...props} /> : <ReorderableBodyRow {...props} rowKey={String(key)} />;
}

function ReorderableBodyRow({ rowKey, ...props }: BodyRowProps & { rowKey: string }) {
  const { row, handle, isHeld } = useReorderRow(rowKey);
  const filterMotion = useFilterItemMotion({ isHeld });
  return (
    <RowHandleContext.Provider value={handle}>
      <m.tr {...filterMotion} {...props} {...row} />
    </RowHandleContext.Provider>
  );
}

const REORDERABLE_BODY = { body: { row: BodyRow } };

function ReorderablePhoneRow({ rowKey, children }: { rowKey: string; children: React.ReactNode }) {
  const { row, handle, isHeld } = useReorderRow(rowKey);
  const filterMotion = useFilterItemMotion({ isHeld });
  return (
    <RowHandleContext.Provider value={handle}>
      <m.div {...filterMotion} {...row}>{children}</m.div>
    </RowHandleContext.Provider>
  );
}
