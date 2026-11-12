import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { MoreOutlined } from '../icons';
import { useT } from '../../i18n';
import { LabelledActionsContext } from './ToolButton';

const MENU_VIEWPORT_GAP = 12;
const MENU_CHROME = 2 * 12;

export interface ActionMenuProps {
  children: React.ReactNode;
  label?: string;
}

interface MenuAnchor {
  placement: 'bottomLeft' | 'bottomRight';
  maxWidth: number;
}

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
  const [anchor, setAnchor] = React.useState<MenuAnchor>();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => setIsOpen(next)}
    >
      <PopoverTrigger
        render={
          <Button
            ref={triggerRef}
            variant="ghost"
            icon={<MoreOutlined />}
            aria-label={label ?? t('common.more')}
            onClick={() => {
              if (!isOpen) setAnchor(anchorFor(triggerRef.current));
            }}
          />
        }
      />
      <PopoverContent
        keepMounted
        placement={anchor?.placement ?? 'bottomRight'}
        initialFocus={() => contentRef.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]') ?? null}
        finalFocus={triggerRef}
        positionerClassName="action-menu-popup"
        className="p-3"
      >
        <div
          ref={contentRef}
          className="action-menu-content"
          style={anchor ? { maxWidth: anchor.maxWidth } : undefined}
          role="group"
          aria-label={label ?? t('common.more')}
          onClick={(event) => {
            const target = event.target;
            const action = target instanceof Element ? target.closest('button, a[href]') : null;
            if (action && !action.hasAttribute('disabled')) {
              setIsOpen(false);
            }
          }}
        >
          <LabelledActionsContext.Provider value>{children}</LabelledActionsContext.Provider>
        </div>
      </PopoverContent>
    </Popover>
  );
}
