import React from 'react';
import { omcToastManager } from '@/components/ui/toast';
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

export interface Toast {
  success: (title: React.ReactNode, options?: ToastOptions) => void;
  info: (title: React.ReactNode, options?: ToastOptions) => void;
  warning: (title: React.ReactNode, options?: ToastOptions) => void;
  error: (title: React.ReactNode, options?: ToastOptions) => void;
  pending: (title: React.ReactNode, options?: Pick<ToastOptions, 'key'>) => () => void;
  dismiss: (key: string) => void;
}

export function clearAllToasts(): void {
  omcToastManager.close();
}

export function toastDetail(options: ToastOptions | undefined): React.ReactNode {
  if (!options) return undefined;
  const detail =
    options.detail ??
    (options.error === undefined ? undefined : readableReason(describeError(options.error)) || undefined);
  const items = options.items ?? [];
  if (items.length === 0) return detail;
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
            <ul className="omc-toast-items">
              {entry.isSummarised
                ? summariseToastItems(entry.items).map((summary) => (
                    <li key={summary.reason ?? ''}>
                      <div className="omc-toast-item-reason-head">
                        {summary.reason && readableReason(summary.reason)}
                        <span className="omc-toast-group-count">{summary.names.length}</span>
                      </div>
                      <div className="omc-toast-item-names" data-tip={summary.names.join('\n')}>
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

function openToneToast(tone: ToastTone, title: React.ReactNode, options?: ToastOptions) {
  const seconds = toastDurationSeconds(tone, options);
  const timeout = seconds === false || seconds === 0 ? 0 : seconds * 1000;
  const body = toastDetail(options);
  omcToastManager.add({
    id: options?.key,
    type: tone,
    timeout,
    priority: 'low',
    data: {
      headline: title,
      body,
      actions: options?.actions,
      closable: true,
      testId: options?.testId,
    },
  });
}

const SHARED_TOAST: Toast = {
  success: (title, options) => openToneToast('success', title, options),
  info: (title, options) => openToneToast('info', title, options),
  warning: (title, options) => openToneToast('warning', title, options),
  error: (title, options) => openToneToast('error', title, options),
  pending: (title, options) => {
    const id = omcToastManager.add({
      id: options?.key,
      type: 'pending',
      timeout: 0,
      priority: 'low',
      data: {
        headline: title,
        closable: false,
      },
    });
    return () => {
      omcToastManager.close(id);
    };
  },
  dismiss: (key) => {
    omcToastManager.close(key);
  },
};

export function useToast(): Toast {
  return SHARED_TOAST;
}
