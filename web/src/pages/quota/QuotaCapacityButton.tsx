import React from 'react';
import { useT } from '../../i18n';
import type { QuotaWindow } from '../../types/quota';
import QuotaCapacityDialog from './QuotaCapacityDialog';
import styles from './QuotaPresentation.module.css';

interface QuotaCapacityScopeValue {
  isBlocked: boolean;
}

const QuotaCapacityScopeContext = React.createContext<QuotaCapacityScopeValue | null>(null);

/** Suppresses or dismisses row-level capacity dialogs while a page overlay is active. */
export function QuotaCapacityScope({ isBlocked, children }: { isBlocked: boolean; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ isBlocked }), [isBlocked]);
  return <QuotaCapacityScopeContext.Provider value={value}>{children}</QuotaCapacityScopeContext.Provider>;
}

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
  const scope = React.useContext(QuotaCapacityScopeContext);
  const isBlocked = Boolean(scope?.isBlocked);
  const [isOpen, setIsOpen] = React.useState(false);
  const [hasOpened, setHasOpened] = React.useState(false);

  React.useEffect(() => {
    if (isBlocked && isOpen) setIsOpen(false);
  }, [isBlocked, isOpen]);

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
          if (isBlocked) return;
          setHasOpened(true);
          setIsOpen(true);
        }}
      >
        {children}
      </button>
      {hasOpened && (
        <QuotaCapacityDialog
          open={isOpen && !isBlocked}
          onClose={() => setIsOpen(false)}
          owner={owner}
          window={window}
        />
      )}
    </>
  );
}
