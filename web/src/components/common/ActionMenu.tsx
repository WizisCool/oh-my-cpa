import React from 'react';
import { Button, Popover } from 'antd';
import { MoreOutlined } from '../icons';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';

export interface ActionMenuProps {
  children: React.ReactNode;
  label?: string;
}

/** Keeps actual action controls mounted, including dialogs owned by a menu action. */
export function ActionMenu({ children, label }: ActionMenuProps) {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };
  useOverlayHistory({ isOpen, onClose: closeMenu });

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={isOpen}
      onOpenChange={setIsOpen}
      afterOpenChange={(hasOpened) => {
        if (hasOpened) contentRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled), a[href]')?.focus();
        else if (document.activeElement === document.body || contentRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus({ preventScroll: true });
        }
      }}
      classNames={{ root: 'action-menu-popup' }}
      content={(
        <div
          ref={contentRef}
          className="action-menu-content"
          role="group"
          aria-label={label ?? t('common.more')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeMenu();
            }
          }}
          onClick={(event) => {
            const target = event.target;
            const action = target instanceof Element ? target.closest('button, a[href]') : null;
            // Dialogs capture their return target on mount. Hand off the visible trigger
            // before they mount, instead of a menu control that is about to become hidden.
            if (action && !action.hasAttribute('disabled')) {
              if (contentRef.current?.contains(document.activeElement) || document.activeElement === document.body) {
                triggerRef.current?.focus({ preventScroll: true });
              }
              setIsOpen(false);
            }
          }}
        >
          {children}
        </div>
      )}
    >
      <Button
        ref={triggerRef}
        type="text"
        icon={<MoreOutlined />}
        aria-label={label ?? t('common.more')}
        aria-expanded={isOpen}
      />
    </Popover>
  );
}
