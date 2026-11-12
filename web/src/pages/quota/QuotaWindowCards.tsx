import { Meter } from '../../components/common/Meter';
import { useT } from '../../i18n';
import type { QuotaWindow } from '../../types/quota';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { compactQuotaCapacity } from './quotaCapacity';
import { QuotaCapacityButton, type QuotaCapacityOwner } from './QuotaCapacityButton';
import { quotaRemainingPercent, quotaResetCountdown, quotaResetText } from './quotaFormat';
import { quotaRemainingStroke } from './quotaThresholds';
import { quotaWindowGroupName, quotaWindowName } from './quotaWindowSelection';
import styles from './QuotaWindowCards.module.css';

export interface QuotaWindowCardsProps {
  windows: QuotaWindow[];
  nowMS: number;
  /** The credential the windows belong to; with it a window's estimate opens its details. */
  owner?: QuotaCapacityOwner;
}

/**
 * A credential's limits, one card each. Cards of one model group share a heading, so the group is
 * read once and every card names only its period. A card states what is left, when it resets and,
 * where one applies, the window's estimated size; the details of that estimate open from the card.
 */
export function QuotaWindowCards({ windows, nowMS, owner }: QuotaWindowCardsProps) {
  const t = useT();
  const groups: Array<{ name: string | null; windows: QuotaWindow[] }> = [];
  for (const window of windows) {
    const name = quotaWindowGroupName(window);
    const last = groups.at(-1);
    if (last && last.name === name) last.windows.push(window);
    else groups.push({ name, windows: [window] });
  }
  return (
    <div className={styles.groups}>
      {groups.map((group, index) => (
        <section key={`${group.name ?? 'plan'}-${index}`} className={styles.group} aria-label={group.name ?? undefined}>
          {group.name && <div className={styles['group-name']}>{group.name}</div>}
          <div className={styles.grid}>
            {group.windows.map((window) => (
              <QuotaWindowCard key={window.id} window={window} siblings={group.windows} name={quotaWindowName(window, t)} nowMS={nowMS} owner={owner} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function QuotaWindowCard({ window, siblings, name, nowMS, owner }: {
  window: QuotaWindow;
  siblings: readonly QuotaWindow[];
  name: string;
  nowMS: number;
  owner?: QuotaWindowCardsProps['owner'];
}) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const remaining = quotaRemainingPercent(window);
  const stroke = quotaRemainingStroke(remaining);
  const reset = quotaResetCountdown(window, nowMS, t);
  const resetTitle = window.reset_accuracy && window.reset_accuracy !== 'exact' ? t('quota.reset_estimated_hint') : quotaResetText(window, nowMS, t);
  const estimate = compactQuotaCapacity(window, tokenStyle, t);
  // A window the estimate applies to opens its details, even before there is a figure: the
  // details say what was recorded and what starts one.
  const hasDetails = Boolean(owner && (window.capacity || window.usage || window.capacity_unavailable));
  const content = (
    <>
      <span className={styles.head}>
        <span className={styles.name} data-tip={window.label} data-tip-overflow="">{name}</span>
        <span className={styles.value}>
          <span className={styles['value-prefix']}>{t('omc.quota_remaining_prefix')}</span>
          <b style={remaining != null && remaining < 70 ? { color: stroke } : undefined}>{remaining == null ? '--' : `${remaining}%`}</b>
        </span>
      </span>
      <Meter value={remaining ?? 0} color={stroke} label={remaining == null ? undefined : name} />
      {window.description && <span className={styles.description} data-tip={window.description} data-tip-overflow="">{window.description}</span>}
      <span className={styles.foot}>
        <span className={styles.estimate}>
          {estimate && <>{t('quota.capacity_estimate')} <b>{estimate}</b></>}
        </span>
        {reset && <span className={styles.reset} data-tip={resetTitle}>{reset === t('quota.recovered') ? reset : t('quota.capacity_resets', { when: reset })}</span>}
      </span>
    </>
  );
  if (hasDetails && owner) {
    return (
      <QuotaCapacityButton className={styles.card} owner={owner} window={window} windows={siblings}>
        {content}
      </QuotaCapacityButton>
    );
  }
  return <div className={styles.card}>{content}</div>;
}
