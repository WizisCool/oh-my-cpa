import * as React from 'react';
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  LoaderCircle,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type OmcToastTone = 'success' | 'info' | 'warning' | 'error' | 'pending';

export interface OmcToastData {
  headline: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
  closable?: boolean;
  testId?: string;
}

export const omcToastManager = ToastPrimitive.createToastManager<OmcToastData>();

const TONE_ICONS: Record<OmcToastTone, React.ReactNode> = {
  success: <CheckCircle2 className="size-[18px] text-success shrink-0" aria-hidden="true" />,
  info: <Info className="size-[18px] text-brand shrink-0" aria-hidden="true" />,
  warning: <AlertTriangle className="size-[18px] text-warn shrink-0" aria-hidden="true" />,
  error: <AlertCircle className="size-[18px] text-danger shrink-0" aria-hidden="true" />,
  pending: <LoaderCircle className="size-[18px] text-muted-foreground animate-spin shrink-0" aria-hidden="true" />,
};

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager<OmcToastData>();
  if (toasts.length === 0) return null;

  return (
    <ToastPrimitive.Portal>
      <ToastPrimitive.Viewport className="fixed top-4 left-1/2 z-[1120] flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2.5 outline-none pointer-events-none">
        {toasts.map((toast) => {
          const tone = ((toast.type as OmcToastTone | undefined) ?? 'info');
          const data = toast.data;
          const closable = data?.closable ?? true;
          const role = tone === 'error' || tone === 'warning' ? 'alert' : 'status';
          return (
            <ToastPrimitive.Root
              key={toast.id}
              toast={toast}
              swipeDirection="up"
              role={role}
              data-slot="toast"
              data-testid={data?.testId}
              className={cn(
                'omc-float-surface pointer-events-auto omc-toast flex w-full items-start gap-3 rounded-xl bg-elevated px-4 py-3.5 text-foreground shadow-float outline-none',
                `omc-toast-${tone}`,
                'data-limited:hidden',
              )}
            >
              <span className="mt-0.5 inline-flex shrink-0">{TONE_ICONS[tone]}</span>
              <ToastPrimitive.Content className="flex flex-1 min-w-0 flex-col gap-1">
                {data?.headline !== undefined && data.headline !== null && (
                  <div className="m-0 text-base font-medium leading-normal text-foreground break-words">
                    {data.headline}
                  </div>
                )}
                {data?.body !== undefined && data.body !== null && data.body !== false && (
                  <div className="m-0 max-h-[min(320px,50vh)] overflow-y-auto text-md leading-normal text-fg-2 break-words">
                    {data.body}
                  </div>
                )}
                {data?.actions !== undefined && data.actions !== null && data.actions !== false && (
                  <div className="mt-1.5 flex items-center gap-2">{data.actions}</div>
                )}
              </ToastPrimitive.Content>
              {closable && (
                <ToastPrimitive.Close
                  aria-label="Close"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-meta hover:bg-secondary hover:text-foreground cursor-pointer"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </ToastPrimitive.Close>
              )}
            </ToastPrimitive.Root>
          );
        })}
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  );
}

export function Toaster() {
  return (
    <ToastPrimitive.Provider toastManager={omcToastManager} limit={6}>
      <ToastList />
    </ToastPrimitive.Provider>
  );
}
