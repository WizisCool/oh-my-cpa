import React from 'react';
import clsx from 'clsx';
import { CredentialMark } from '../../components/LobeIcon';
import { AppModal } from '../../components/common/AppModal';
import { ReorderHandle, RowReorder, useReorderRow } from '../../components/common/RowReorder';
import { SearchInput } from '../../components/common/SearchInput';
import { ToolButton } from '../../components/common/ToolButton';
import { AppstoreOutlined, PlusOutlined, ListOutlined } from '../../components/icons';
import { useT } from '../../i18n';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { providerDisplayName } from '../../types/providerMetadata';
import type { DropSide } from '../../types/displayOrder';
import type { ProviderSummary } from './fleetPresentation';
import styles from './ProviderStrip.module.css';

/** Past this many providers the list gains a field to find one by name. */
const SEARCHABLE_FROM = 8;

export interface ProviderStripProps {
  summaries: readonly ProviderSummary[];
  /** Every credential, and how many of them need a hand, for the "All" entry. */
  total: number;
  attention: number;
  active: string;
  onChange: (provider: string) => void;
  onConnect: () => void;
  pluginLogos?: PluginOAuthLogos;
  pluginTitles?: ReadonlyMap<string, string>;
  reorder: {
    isEnabled: boolean;
    onMove: (key: string, target: string, side: DropSide) => void;
    onStep: (key: string, direction: -1 | 1) => void;
  };
}

/**
 * The providers as one row of tabs over the credentials: the workspace's scope, taking a line rather
 * than a column so the tables keep the page's whole width.
 *
 * Each tab carries the provider's count and, when any of its credentials needs a hand, how many. A
 * row that outgrows the width scrolls; the button at its end opens every provider as a list, where
 * one is found by name, providers are arranged, and another account is connected. That arrangement
 * is the order the tabs and the credential groups follow.
 */
export function ProviderStrip(props: ProviderStripProps) {
  const t = useT();
  const { summaries, total, attention, active, onChange, pluginLogos, pluginTitles } = props;
  const [isOpen, setIsOpen] = React.useState(false);
  const scroller = React.useRef<HTMLDivElement>(null);
  // The tab in scope is kept in view, whichever way the scope changed.
  React.useEffect(() => {
    const tab = scroller.current?.querySelector<HTMLElement>('[aria-current="true"]');
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const tab = (provider: string, mark: React.ReactNode, name: string, count: number, needs: number, testId: string) => (
    <button
      key={provider}
      type="button"
      className={clsx(styles.tab, active === provider && styles['tab-active'])}
      aria-current={active === provider ? 'true' : undefined}
      onClick={() => onChange(provider)}
      data-testid={testId}
    >
      {/* A provider that needs a look carries a dot on its mark; the count is in its name, so the
          tab reads one figure, its total. */}
      <span className={styles['tab-mark']}>
        {mark}
        {needs > 0 && <span className={styles.attention} role="img" aria-label={t('omc.fleet_attention_n', { n: needs })} title={t('omc.fleet_attention_n', { n: needs })} />}
      </span>
      <span className={styles['tab-name']}>{name}</span>
      <span className={styles['tab-count']}>{count}</span>
    </button>
  );
  return (
    <nav className={styles.strip} aria-label={t('omc.fleet_providers')}>
      <div ref={scroller} className={styles.tabs}>
        {tab('all', <AppstoreOutlined aria-hidden />, t('omc.fleet_all_accounts'), total, attention, 'oauth-provider-all')}
        {summaries.map((summary) => tab(
          summary.provider,
          <CredentialMark credential={{ provider: summary.provider }} pluginLogos={pluginLogos} size={16} />,
          providerDisplayName(summary.provider, pluginTitles),
          summary.total,
          summary.attention,
          `oauth-provider-${summary.provider}`,
        ))}
      </div>
      <ToolButton
        icon={<ListOutlined />}
        label={t('omc.fleet_providers')}
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        data-testid="oauth-provider-switcher"
      />
      <AppModal open={isOpen} title={t('omc.fleet_providers')} size="small" footer={null} destroyOnHidden onCancel={() => setIsOpen(false)}>
        <ProviderList
          {...props}
          onChange={(provider) => {
            onChange(provider);
            setIsOpen(false);
          }}
          onConnect={() => {
            setIsOpen(false);
            props.onConnect();
          }}
        />
      </AppModal>
    </nav>
  );
}

/** Every provider as a list: find one by name, arrange them, or connect another account. */
function ProviderList({
  summaries, total, attention, active, onChange, onConnect, pluginLogos, pluginTitles, reorder,
}: ProviderStripProps) {
  const t = useT();
  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLowerCase();
  const named = summaries.map((summary) => ({ ...summary, name: providerDisplayName(summary.provider, pluginTitles) }));
  const shown = needle
    ? named.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.provider.includes(needle))
    : named;
  const keys = React.useMemo(() => shown.map((entry) => entry.provider), [shown]);
  // A search hides providers, and a drag among the ones left would move them past hidden ones.
  const canReorder = reorder.isEnabled && !needle && summaries.length > 1;
  return (
    <div className={styles.list}>
      {summaries.length >= SEARCHABLE_FROM && (
        <SearchInput className={styles.search} value={query} onChange={setQuery} label={t('omc.fleet_find_provider')} size="small" />
      )}
      {!needle && (
        <RailItem
          isActive={active === 'all'}
          mark={<span className={styles['all-mark']}><AppstoreOutlined aria-hidden /></span>}
          name={t('omc.fleet_all_accounts')}
          total={total}
          attention={attention}
          onClick={() => onChange('all')}
        />
      )}
      <div className={styles.divider} role="presentation" />
      <RowReorder items={keys} isEnabled={canReorder} onMove={reorder.onMove} onStep={reorder.onStep}>
        {shown.map((entry) => (
          <SortableRailItem
            key={entry.provider}
            provider={entry.provider}
            isActive={active === entry.provider}
            mark={<CredentialMark credential={{ provider: entry.provider }} pluginLogos={pluginLogos} size={18} />}
            name={entry.name}
            total={entry.total}
            attention={entry.attention}
            onClick={() => onChange(entry.provider)}
          />
        ))}
      </RowReorder>
      {needle && shown.length === 0 && <p className={styles.none}>{t('omc.fleet_no_provider')}</p>}
      <button type="button" className={styles.connect} onClick={onConnect}>
        <PlusOutlined aria-hidden />
        <span>{t('omc.fleet_connect_provider')}</span>
      </button>
    </div>
  );
}

interface RailItemProps {
  isActive: boolean;
  mark: React.ReactNode;
  name: string;
  total: number;
  attention: number;
  onClick: () => void;
}

function RailItem({ isActive, mark, name, total, attention, onClick, handle, rowProps }: RailItemProps & {
  handle?: React.ReactNode;
  rowProps?: ReturnType<typeof useReorderRow>['row'];
}) {
  const t = useT();
  return (
    <div {...rowProps} className={clsx(styles.item, isActive && styles['item-active'])}>
      {handle}
      <button
        type="button"
        className={styles['item-button']}
        aria-current={isActive ? 'true' : undefined}
        onClick={onClick}
      >
        <span className={styles['item-mark']}>
          {mark}
          {attention > 0 && <span className={styles.attention} role="img" aria-label={t('omc.fleet_attention_n', { n: attention })} title={t('omc.fleet_attention_n', { n: attention })} />}
        </span>
        <span className={styles['item-name']} title={name}>{name}</span>
        <span className={styles['item-count']}>{total}</span>
      </button>
    </div>
  );
}

function SortableRailItem({ provider, ...props }: RailItemProps & { provider: string }) {
  const reorder = useReorderRow(provider);
  return (
    <RailItem
      {...props}
      rowProps={reorder.row}
      handle={<ReorderHandle {...reorder.handle} name={props.name} variant="inline" className={styles.handle} />}
    />
  );
}
