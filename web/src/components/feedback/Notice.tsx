import React from 'react';
import { Button } from 'antd';
import { CloseOutlined, ReloadOutlined } from '../icons';
import { describeError } from '../../api/client';
import { useT } from '../../i18n';
import { readableReason } from './toastContent';

/**
 * The console's inline surface for a condition that holds while a region is on screen: demo mode,
 * stale data, a feature switched off, a diagnostic about a record. It is placed where the condition
 * applies and stays until the condition does not. The outcome of an action is a toast instead
 * (`useToast`), so a page never collects banners that describe clicks the operator already made.
 */
export type NoticeTone = 'info' | 'warning' | 'error' | 'success';

export interface NoticeProps {
  tone: NoticeTone;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  /** Present only when the condition may be put away; a condition that still holds is not closable. */
  onClose?: () => void;
  className?: string;
  'data-testid'?: string;
}

/**
 * The tone as a status code. It is the same four words in every reading language, the way a log
 * level or an HTTP status is: a label that changed with the language would be one more thing to
 * translate and one less thing to recognise at a glance or to search a screenshot for.
 */
const TONE_CODES: Record<NoticeTone, string> = {
  info: 'INFO',
  warning: 'WARNING',
  error: 'ERROR',
  success: 'SUCCESS',
};

/**
 * Drawn as a callout rather than a boxed banner: a 2px rule in the tone's colour, the tone's code
 * on its own line in the console's small label type, then the sentence at the full measure. The
 * code carries the tone, so it never rests on colour.
 */
export const Notice: React.FC<NoticeProps> = ({ tone, title, description, action, icon, onClose, className, 'data-testid': testId }) => {
  const t = useT();
  return (
    <div role="alert" className={['omc-notice', `is-${tone}`, onClose && 'is-closable', className].filter(Boolean).join(' ')} data-testid={testId}>
      <div className="omc-notice-main">
        <span className="omc-notice-label">
          {icon && <span className="omc-notice-icon" aria-hidden="true">{icon}</span>}
          {TONE_CODES[tone]}
        </span>
        {/* One layout for every notice: the headline, and its detail under it when it has one, so a
            failure with a reason reads no louder than the same failure without. */}
        <div className="omc-notice-body">
          <span className="omc-notice-title">{title ?? description}</span>
          {title && description && <span className="omc-notice-detail">{description}</span>}
        </div>
      </div>
      {action && <div className="omc-notice-tools">{action}</div>}
      {/* The close control is pinned to the code's line in a gutter of its own, so it is in the same
          corner whether the action sits beside the sentence or has wrapped under it. */}
      {onClose && (
        <button type="button" className="omc-notice-close" onClick={onClose} aria-label={t('common.close')}>
          <CloseOutlined />
        </button>
      )}
    </div>
  );
};

export interface LoadFailureProps {
  /** What could not be read, in the reader's words: "Quota could not be read". */
  title: React.ReactNode;
  /** The failure itself; its message becomes the detail line. */
  error?: unknown;
  /** Replaces the described error, for a failure the page already words. */
  detail?: React.ReactNode;
  /** Re-reads the region. Every failed read that can be repeated offers it. */
  onRetry?: () => void;
  /** A failed read that left the previous data on screen is a warning, not an error. */
  tone?: 'error' | 'warning';
  className?: string;
  'data-testid'?: string;
}

/**
 * A region whose data could not be read: it names what failed, why, and offers the retry in place,
 * so the operator repairs the one panel without reloading the page around it.
 */
export const LoadFailure: React.FC<LoadFailureProps> = ({ title, error, detail, onRetry, tone = 'error', className, 'data-testid': testId }) => {
  const t = useT();
  const description = detail ?? (error === undefined ? undefined : readableReason(describeError(error)) || undefined);
  return (
    <Notice
      tone={tone}
      title={title}
      description={description}
      className={['omc-load-failure', className].filter(Boolean).join(' ')}
      data-testid={testId}
      action={onRetry ? (
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : undefined}
    />
  );
};
