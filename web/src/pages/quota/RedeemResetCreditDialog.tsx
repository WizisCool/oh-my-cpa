import React from 'react';
import clsx from 'clsx';
import { AppModal } from '../../components/common/AppModal';
import { Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import type { CodexResetCredit, CodexResetCreditsInfo } from '../../types/quota';
import {
  formatCodexResetCreditExpiry,
  isCodexResetCreditEligible,
  orderCodexResetCredits,
} from './quotaFormat';
import styles from './RedeemResetCreditDialog.module.css';

export interface RedeemResetCreditDialogProps {
  open: boolean;
  credits?: CodexResetCreditsInfo;
  /** The credential the credit is spent for, named as the page names it (already masked). */
  targetName: string;
  nowMS: number;
  /** Receives the chosen credit ID, or `undefined` when upstream listed no credits to choose from. */
  onConfirm: (creditId?: string) => unknown | Promise<unknown>;
  onClose: () => void;
}

/**
 * The one place a Codex reset credit is spent. Every entry (the quota drawer's Reset quota and a
 * credential menu's Use a reset) opens it, so the credit to spend is always seen and confirmed in
 * the same shape: the earliest-expiring credit is preselected, another can be picked, and nothing
 * is spent until the destructive confirmation is pressed.
 */
export function RedeemResetCreditDialog({ open, credits, targetName, nowMS, onConfirm, onClose }: RedeemResetCreditDialogProps) {
  const t = useT();
  const optionRefs = React.useRef(new Map<string, HTMLButtonElement>());

  // Card numbers follow the drawer's list, expired entries included, so "Credit #3" names the
  // same card in both places.
  const listed = orderCodexResetCredits(credits?.credits);
  const numbered = listed.map((credit, index) => ({ credit, number: index + 1 }));
  const eligible = numbered.filter(({ credit }) => isCodexResetCreditEligible(credit, nowMS));
  const defaultId = eligible[0]?.credit.id.trim() ?? '';
  const isUnlisted = listed.length === 0;

  // Latch the opening default and unlisted mode on first open mount and every reopen so a
  // background quota poll removing or expiring credits cannot silently switch the target credit
  // or downgrade an explicit selection into automatic backend selection.
  const [selectedId, setSelectedId] = React.useState<string | null>(() => (open ? (defaultId || null) : null));
  const [isOpenedSingle, setIsOpenedSingle] = React.useState(() => open && eligible.length === 1);
  const [isOpenedUnlisted, setIsOpenedUnlisted] = React.useState(() => open && isUnlisted);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelectedId(defaultId || null);
      setIsOpenedSingle(eligible.length === 1);
      setIsOpenedUnlisted(isUnlisted);
    }
  }
  const activeId = selectedId?.trim() ?? '';
  const selectedCredit = activeId
    ? eligible.find(({ credit }) => credit.id.trim() === activeId)?.credit ?? null
    : null;
  const isAutoMode = isUnlisted && isOpenedUnlisted && !activeId;
  const hasNoneEligible = !isAutoMode && eligible.length === 0;
  const isSelectionUnavailable = !isAutoMode && Boolean(activeId) && !selectedCredit && eligible.length > 0;
  const canConfirm = !isSubmitting && (isAutoMode ? (credits?.available_count ?? 0) > 0 : Boolean(selectedCredit));

  const pick = (credit: CodexResetCredit) => {
    if (isSubmitting) return;
    setSelectedId(credit.id.trim());
    setIsOpenedSingle(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, position: number) => {
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (position + 1) % eligible.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (position - 1 + eligible.length) % eligible.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = eligible.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = eligible[next]?.credit;
    if (!target) return;
    pick(target);
    optionRefs.current.get(target.id.trim())?.focus();
  };

  const confirm = async () => {
    if (!canConfirm) return;
    setIsSubmitting(true);
    try {
      await onConfirm(isAutoMode ? undefined : selectedCredit?.id.trim());
    } finally {
      setIsSubmitting(false);
      onClose();
    }
  };

  const renderFacts = (credit: CodexResetCredit, number: number, isSoonest: boolean) => {
    const expiry = formatCodexResetCreditExpiry(credit, nowMS, t);
    return (
      <>
        <span className={styles['option-name']}>
          <span className={styles['option-label']}>{t('quota.reset_credit_item', { n: number })}</span>
          {isSoonest && <span className={styles['option-soonest']}>{t('quota.reset_credit_soonest')}</span>}
        </span>
        <span className={styles['option-expiry']}>
          <span className={styles['option-countdown']}>{expiry.primary}</span>
          {expiry.dateText && <span className={styles['option-date']}>{expiry.dateText}</span>}
        </span>
      </>
    );
  };

  const body = (() => {
    if (hasNoneEligible) {
      return <Notice tone="warning" description={t('quota.reset_credit_none_eligible')} />;
    }
    if (isAutoMode) {
      return (
        <div className={styles.tray}>
          <div className={styles.option} data-redeem-credit-summary="">
            <span className={styles['option-label']}>{t('quota.reset_credits_title')}</span>
            <span className={styles['option-countdown']}>
              {t('quota.reset_available')} <b>{credits?.available_count ?? 0}</b>
            </span>
          </div>
        </div>
      );
    }
    if (eligible.length === 1 && Boolean(selectedCredit) && isOpenedSingle) {
      const only = eligible[0];
      return (
        <div className={styles.tray}>
          <div className={styles.option} data-redeem-credit={only.credit.id.trim()}>
            {renderFacts(only.credit, only.number, false)}
          </div>
        </div>
      );
    }
    return (
      <div className={styles.body}>
        {isSelectionUnavailable && <Notice tone="warning" description={t('quota.reset_credit_selection_changed')} />}
        <div className={styles.tray} role="radiogroup" aria-label={t('quota.reset_credit_pick')}>
          {eligible.map(({ credit, number }, position) => {
            const id = credit.id.trim();
            const isSelected = Boolean(selectedCredit) && id === activeId;
            const isFocusable = selectedCredit ? isSelected : position === 0;
            return (
              <button
                key={id}
                ref={(node) => {
                  if (node) optionRefs.current.set(id, node);
                  else optionRefs.current.delete(id);
                }}
                type="button"
                role="radio"
                aria-checked={isSelected}
                tabIndex={isFocusable ? 0 : -1}
                disabled={isSubmitting}
                className={clsx(styles.option, styles['is-choice'], isSelected && styles['is-selected'])}
                data-redeem-credit={id}
                onClick={() => pick(credit)}
                onKeyDown={(event) => handleKeyDown(event, position)}
              >
                {renderFacts(credit, number, eligible.length > 1 && id === defaultId)}
              </button>
            );
          })}
        </div>
      </div>
    );
  })();

  return (
    <AppModal
      open={open}
      size="small"
      title={t('quota.redeem_credit_confirm_title')}
      description={t(isAutoMode ? 'quota.redeem_credit_confirm_auto' : 'quota.redeem_credit_confirm_desc', { name: targetName })}
      okText={t('quota.redeem_credit_confirm_ok')}
      okButtonProps={{ danger: true, disabled: !canConfirm && !isSubmitting }}
      cancelButtonProps={{ disabled: isSubmitting }}
      confirmLoading={isSubmitting}
      isDismissible={!isSubmitting}
      onOk={() => void confirm()}
      onCancel={() => {
        if (!isSubmitting) onClose();
      }}
      data-testid="redeem-reset-credit-dialog"
    >
      {body}
    </AppModal>
  );
}
