import React from 'react';
import { App as AntdApp } from 'antd';
import { LoadingOutlined } from '../icons';
import { describeError } from '../../api/client';
import {
  groupToastItems,
  readableReason,
  summariseToastItems,
  toastDurationSeconds,
  type ToastOptions,
  type ToastTone,
} from './toastContent';

export type { ToastItem, ToastItemGroup, ToastOptions, ToastTone } from './toastContent';

/**
 * The console's one surface for the outcome of something the operator just did.
 *
 * A toast answers an action - saved, copied, refused, three of five refreshed - and then leaves.
 * What is true of a region for as long as it is on screen (its data failed to load, it is stale,
 * a feature is off) is not an outcome and belongs inline, through `Notice` or `LoadFailure`, where
 * the reader looks for the region and where its retry sits. `docs/design.md` §Feedback surfaces
 * owns the rule; `pnpm check:feedback` keeps the raw Ant Design APIs from bypassing it.
 */
export interface Toast {
  success: (title: React.ReactNode, options?: ToastOptions) => void;
  info: (title: React.ReactNode, options?: ToastOptions) => void;
  warning: (title: React.ReactNode, options?: ToastOptions) => void;
  error: (title: React.ReactNode, options?: ToastOptions) => void;
  /** A toast for work in flight, returning the function that closes it. */
  pending: (title: React.ReactNode, options?: Pick<ToastOptions, 'key'>) => () => void;
  dismiss: (key: string) => void;
}

let pendingSequence = 0;

export function toastDetail(options: ToastOptions | undefined): React.ReactNode {
  if (!options) return undefined;
  const detail = options.detail ?? (options.error === undefined ? undefined : readableReason(describeError(options.error)) || undefined);
  const items = options.items ?? [];
  if (items.length === 0) return detail;
  // Each target is a name on its own line with its reason under it: a two-column row truncated the
  // name - the one thing that says which credential to go and fix - and squeezed the reason into a
  // column too narrow to read.
  return (
    <>
      {detail && <div className="omc-toast-detail">{detail}</div>}
      <div className="omc-toast-report">
        {groupToastItems(items).map((entry, groupIndex) => (
          <section key={entry.group ?? `group-${groupIndex}`} className="omc-toast-group">
            {entry.group && (
              <div className="omc-toast-group-head">
                <span>{entry.group}</span>
                <span className="omc-toast-group-count">{entry.items.length}</span>
              </div>
            )}
            {/* Nothing in a toast may change height after it opens: antd places each toast from
                the heights it measured on arrival, so a group that expanded in place would slide
                under the toast below it. A long group is therefore summarised, never folded. */}
            <ul className="omc-toast-items">
              {entry.isSummarised
                ? summariseToastItems(entry.items).map((summary) => (
                  <li key={summary.reason ?? ''}>
                    <div className="omc-toast-item-reason-head">
                      {summary.reason && readableReason(summary.reason)}
                      <span className="omc-toast-group-count">{summary.names.length}</span>
                    </div>
                    <div className="omc-toast-item-names" title={summary.names.join('\n')}>
                      {summary.names.join(', ')}
                    </div>
                  </li>
                ))
                : entry.items.map((item, index) => (
                  <li key={`${item.name}-${index}`}>
                    <div className="omc-toast-item-name">{item.name}</div>
                    {item.reason && <div className="omc-toast-item-reason">{readableReason(item.reason)}</div>}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

export function useToast(): Toast {
  const { notification } = AntdApp.useApp();
  return React.useMemo(() => {
    const show = (tone: ToastTone) => (title: React.ReactNode, options?: ToastOptions) => {
      notification.open({
        type: tone,
        key: options?.key,
        title,
        description: toastDetail(options),
        actions: options?.actions,
        duration: toastDurationSeconds(tone, options),
        pauseOnHover: true,
        className: `omc-toast omc-toast-${tone}`,
        role: tone === 'error' || tone === 'warning' ? 'alert' : 'status',
        props: options?.testId ? { 'data-testid': options.testId } : undefined,
      });
    };
    return {
      success: show('success'),
      info: show('info'),
      warning: show('warning'),
      error: show('error'),
      pending: (title, options) => {
        pendingSequence += 1;
        const key = options?.key ?? `omc-toast-pending-${pendingSequence}`;
        notification.open({
          key,
          title,
          icon: <LoadingOutlined />,
          duration: false,
          closable: false,
          className: 'omc-toast omc-toast-pending',
          role: 'status',
        });
        return () => notification.destroy(key);
      },
      dismiss: (key) => notification.destroy(key),
    };
  }, [notification]);
}
