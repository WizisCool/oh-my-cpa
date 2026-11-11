import React from 'react';
import { useT } from '../../i18n';
import type { QuotaWindow } from '../../types/quota';
import styles from './QuotaPresentation.module.css';

// The dialog and its chart load on first open, so a list of credentials carries neither.
const QuotaCapacityDialog = React.lazy(() => import('./QuotaCapacityDialog'));

/** The credential a window belongs to, as the details name it. */
export interface QuotaCapacityOwner {
  authIndex: string;
  credentialName: string;
  /** The credential's brand mark, drawn beside the details' title. */
  mark?: React.ReactNode;
}

export interface QuotaCapacityButtonProps {
  owner: QuotaCapacityOwner;
  window: QuotaWindow;
  /** Replaces the inline text style, for a trigger that is a whole surface. */
  className?: string;
  children: React.ReactNode;
}

/** A window's estimate that opens its capacity details. */
export function QuotaCapacityButton({ owner, window, className, children }: QuotaCapacityButtonProps) {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const [hasOpened, setHasOpened] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className={className ?? styles['capacity-trigger']}
        aria-haspopup="dialog"
        data-tip={t('quota.capacity_open_details')}
        // A row or reading around the estimate may answer clicks of its own.
        onClick={(event) => {
          event.stopPropagation();
          setHasOpened(true);
          setIsOpen(true);
        }}
      >
        {children}
      </button>
      {hasOpened && (
        <React.Suspense fallback={null}>
          <QuotaCapacityDialog
            open={isOpen}
            onClose={() => setIsOpen(false)}
            owner={owner}
            window={window}
          />
        </React.Suspense>
      )}
    </>
  );
}
