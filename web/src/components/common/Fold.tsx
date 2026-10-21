import React from 'react';
import styles from './Fold.module.css';

export interface FoldProps {
  isOpen: boolean;
  children: React.ReactNode;
  id?: string;
  className?: string;
}

/**
 * A disclosure body that unfolds from its own height instead of appearing.
 *
 * The body is mounted the first time it opens and kept afterwards, so closing can fold it away
 * rather than cut it, and a list of collapsed cards does not pay for every closed body up front.
 * A body that mounts already open is shown at once; one opened later is mounted folded and opened
 * on the next frame, which is what gives the browser a closed state to animate from. The caller's
 * class sits inside the clipping row, because padding or a rule on the row itself would survive the
 * fold and leave a closed card taller than it was before it opened.
 */
export function Fold({ isOpen, children, id, className }: FoldProps) {
  const [hasOpened, setHasOpened] = React.useState(isOpen);
  const [isShown, setIsShown] = React.useState(isOpen);

  React.useEffect(() => {
    if (!isOpen) {
      setIsShown(false);
      return undefined;
    }
    if (hasOpened) {
      setIsShown(true);
      return undefined;
    }
    setHasOpened(true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setIsShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, hasOpened]);

  if (!hasOpened) return null;
  return (
    <div id={id} className={styles['fold']} data-open={isShown || undefined}>
      <div className={styles['fold-inner']}>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
