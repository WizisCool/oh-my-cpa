import React from 'react';
import { Popover } from 'antd';
import { Button } from '@/components/ui/button';
import { MoreOutlined } from '../icons';
import { useT } from '../../i18n';
import { LabelledActionsContext } from './ToolButton';

/**
 * The distance kept between a menu and the edge of the screen.
 */
const MENU_VIEWPORT_GAP = 12;
/**
 * What the popover adds on either side of the menu's own column - its 12px of padding; the float
 * shadow draws its edge outside the box - so the room a button's label gets is the placement's room
 * less this.
 */
const MENU_CHROME = 2 * 12;

export interface ActionMenuProps {
  children: React.ReactNode;
  label?: string;
}

interface MenuAnchor {
  /** The trigger edge the panel hangs from: its trailing edge, or its leading edge when that side has more room. */
  placement: 'bottomLeft' | 'bottomRight';
  /** The widest the panel may be: wider than the stylesheet's own menu width changes nothing. */
  maxWidth: number;
}

/**
 * A panel hangs from its trigger's trailing edge, where a page's primary action usually is - except
 * when the trigger comes before that action. There the space beside the trigger is narrower than the
 * panel, and an edge-aligned placement can only flip, so the panel opened past the screen's leading
 * edge and cut the first glyph off every action. It takes the room the wider side offers instead.
 */
function anchorFor(trigger: HTMLElement | null): MenuAnchor | undefined {
  if (!trigger) return undefined;
  const rect = trigger.getBoundingClientRect();
  const roomBefore = rect.right - MENU_VIEWPORT_GAP;
  const roomAfter = document.documentElement.clientWidth - rect.left - MENU_VIEWPORT_GAP;
  return {
    placement: roomAfter > roomBefore ? 'bottomLeft' : 'bottomRight',
    maxWidth: Math.max(roomBefore, roomAfter) - MENU_CHROME,
  };
}

/** Keeps actual action controls mounted, including dialogs owned by a menu action. */
export function ActionMenu({ children, label }: ActionMenuProps) {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);
  // Where the trigger stands is read on the way in, so the panel's first paint is already inside
  // the viewport; the click that opens it sets both in one render.
  const [anchor, setAnchor] = React.useState<MenuAnchor>();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <Popover
      trigger="click"
      placement={anchor?.placement ?? 'bottomRight'}
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
          style={anchor ? { maxWidth: anchor.maxWidth } : undefined}
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
          <LabelledActionsContext.Provider value>{children}</LabelledActionsContext.Provider>
        </div>
      )}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        icon={<MoreOutlined />}
        aria-label={label ?? t('common.more')}
        aria-expanded={isOpen}
        onClick={() => {
          // Only the opening click has a panel to place; the closing one would re-place a panel
          // that is already leaving.
          if (!isOpen) setAnchor(anchorFor(triggerRef.current));
        }}
      />
    </Popover>
  );
}
