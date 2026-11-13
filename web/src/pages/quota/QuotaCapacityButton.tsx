import React from 'react';
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
  /** All windows of the credential or family, so the modal can switch between sibling periods (e.g. 5h ↔ weekly). */
  windows?: readonly QuotaWindow[];
  /** Replaces the inline text style, for a trigger that is a whole surface. */
  className?: string;
  /** False keeps an already-open dialog mounted without rendering a visible trigger. */
  hasTrigger?: boolean;
  children: React.ReactNode;
}

/** Opens recorded consumption and model-conditioned forecast details. */
export function QuotaCapacityButton({ owner, window, windows, className, hasTrigger = true, children }: QuotaCapacityButtonProps) {
  const scope = React.useContext(QuotaCapacityScopeContext);
  const isBlocked = Boolean(scope?.isBlocked);
  const [isOpen, setIsOpen] = React.useState(false);
  const [hasOpened, setHasOpened] = React.useState(false);

  React.useEffect(() => {
    if (isBlocked && isOpen) setIsOpen(false);
  }, [isBlocked, isOpen]);

  return (
    <>
      {hasTrigger && (
        <button
          type="button"
          className={className ?? styles['capacity-trigger']}
          aria-haspopup="dialog"
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
      )}
      {hasOpened && (
        <QuotaCapacityDialog
          open={isOpen && !isBlocked}
          onClose={() => setIsOpen(false)}
          owner={owner}
          window={window}
          windows={windows}
        />
      )}
    </>
  );
}
