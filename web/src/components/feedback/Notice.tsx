import React from 'react';
import { Alert, Button } from 'antd';
import { ReloadOutlined } from '../icons';
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

export const Notice: React.FC<NoticeProps> = ({ tone, title, description, action, icon, onClose, className, 'data-testid': testId }) => (
  <Alert
    type={tone}
    showIcon
    icon={icon}
    // One layout for every notice: the headline and its detail share the compact row, because
    // antd's description layout doubles the icon and enlarges the title, and a failure with a
    // reason would otherwise read louder than the same failure without one.
    title={(
      <>
        <span className="omc-notice-title">{title ?? description}</span>
        {title && description && <span className="omc-notice-detail">{description}</span>}
      </>
    )}
    action={action}
    closable={onClose ? { onClose } : undefined}
    className={['omc-notice', className].filter(Boolean).join(' ')}
    data-testid={testId}
  />
);

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
