import React from 'react';
import { Button, Popover } from 'antd';
import { CheckOutlined, DownOutlined } from '../icons';
import { nextPickerIndex, pickerRoom, PICKER_GAP } from './pickerNavigation';
import type { PickerRoom } from './pickerNavigation';
import styles from './Workspace.module.css';

interface ComposerPickerProps {
  label: string;
  valueLabel: string;
  icon?: React.ReactNode;
  testId: string;
  contentTestId: string;
  isDisabled?: boolean;
  isUnset?: boolean;
  /** The stored choice has not been read yet: the trigger holds its place without naming a value. */
  isPending?: boolean;
  className?: string;
  surfaceClassName?: string;
  onOpenChange?: (isOpen: boolean) => void;
  children: (close: () => void) => React.ReactNode;
}

/**
 * Where the surface sits, decided here rather than by the popup library. The library fits a popup
 * inside the nearest scrolling ancestor of its trigger, not inside the window: with the composer
 * in the middle of a scrolling page that region is too short for the list, the fit is abandoned,
 * and the surface hangs over the top of the window. The trigger's own position says how much room
 * there is on each side, and the surface is capped to the side it opens on.
 */
const PICKER_OVERFLOW = { adjustX: false, adjustY: false, shiftX: true, shiftY: false };
const PICKER_PLACEMENTS = {
  topRight: { points: ['br', 'tr'], offset: [0, -PICKER_GAP], overflow: PICKER_OVERFLOW, dynamicInset: true },
  bottomRight: { points: ['tr', 'br'], offset: [0, PICKER_GAP], overflow: PICKER_OVERFLOW, dynamicInset: true },
};

/** Both message settings share one floating surface and one focus/confirmation policy. */
export function ComposerPicker({
  label, valueLabel, icon, testId, contentTestId, isDisabled = false, isUnset = false, isPending = false, className, surfaceClassName, onOpenChange, children,
}: ComposerPickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [room, setRoom] = React.useState<PickerRoom>({ placement: 'topRight', height: 0 });
  const changeOpen = (next: boolean) => {
    const trigger = triggerRef.current;
    if (next && trigger) {
      const bounds = trigger.getBoundingClientRect();
      setRoom(pickerRoom(bounds.top, bounds.bottom, window.visualViewport?.height ?? window.innerHeight));
    }
    setIsOpen(next);
    onOpenChange?.(next);
  };
  const close = () => {
    changeOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  React.useEffect(() => {
    // The parent may hold this state, so a control that became disabled says it closed: a parent
    // left believing it is open draws an open list over a control nobody can use.
    if (isDisabled && isOpen) {
      setIsOpen(false);
      onOpenChange?.(false);
    }
  }, [isDisabled, isOpen, onOpenChange]);

  const content = (
    <div ref={contentRef} className={[styles['picker-surface'], surfaceClassName].filter(Boolean).join(' ')} role="dialog" aria-label={label} data-testid={contentTestId} style={room.height ? { maxHeight: room.height } : undefined} onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      // Search keeps the caret for typing; up/down hand navigation to the visible choices.
      if (event.target instanceof HTMLInputElement) {
        const options = contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const option = event.key === 'ArrowUp' ? options?.[options.length - 1] : options?.[0];
          option?.focus({ preventScroll: true });
          option?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') {
          event.preventDefault();
          options?.[0]?.click();
        }
      }
    }}>
      {children(close)}
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement={room.placement}
      builtinPlacements={PICKER_PLACEMENTS}
      arrow={false}
      open={isOpen && !isDisabled && !isPending}
      onOpenChange={next => { if (!isDisabled || !next) changeOpen(next); }}
      afterOpenChange={next => {
        if (!next) return;
        const first = contentRef.current?.querySelector<HTMLElement>('[data-picker-search] input, [data-picker-list] [tabindex="0"]');
        first?.focus({ preventScroll: true });
        if (first?.matches('[role="option"]')) first.scrollIntoView({ block: 'nearest' });
      }}
      destroyOnHidden
      content={content}
      classNames={{ root: styles['picker-popover'] }}
    >
      <Button
        ref={triggerRef}
        type="text"
        size="small"
        className={[styles['picker-trigger'], className].filter(Boolean).join(' ')}
        data-testid={testId}
        data-state={isPending ? 'pending' : isUnset ? 'unset' : undefined}
        aria-label={isPending ? label : `${label}: ${valueLabel}`}
        aria-busy={isPending || undefined}
        aria-haspopup="dialog"
        aria-expanded={isOpen && !isDisabled}
        disabled={isDisabled || isPending}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            changeOpen(true);
          }
        }}
      >
        {icon && <span className={styles['picker-trigger-icon']} aria-hidden="true">{icon}</span>}
        {isPending
          ? <span className={styles['picker-trigger-pending']} />
          : <span className={styles['picker-trigger-value']} title={valueLabel}>{valueLabel}</span>}
        <DownOutlined className={styles['picker-caret']} aria-hidden="true" />
      </Button>
    </Popover>
  );
}

export interface PickerOption {
  value: string;
  label: string;
  accessibleLabel?: string;
  icon?: React.ReactNode;
  detail?: string;
}

interface ComposerPickerListProps {
  label: string;
  options: PickerOption[];
  value: string;
  onSelect: (value: string) => void;
  optionTestId?: string;
  shouldShowSelectionMark?: boolean;
}

/** Named choices keep a roving tab stop, while arrows do not alter the outgoing request. */
export function ComposerPickerList({ label, options, value, onSelect, optionTestId, shouldShowSelectionMark = true }: ComposerPickerListProps) {
  const [activeValue, setActiveValue] = React.useState(value);
  const listRef = React.useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(0, options.findIndex(option => option.value === activeValue));
  return (
    <div ref={listRef} className={styles['picker-list']} data-picker-list role="listbox" aria-label={label} onKeyDown={event => {
      const next = nextPickerIndex(event.key, activeIndex, options.length);
      if (next === null) return;
      event.preventDefault();
      setActiveValue(options[next].value);
      const option = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next];
      option?.focus({ preventScroll: true });
      option?.scrollIntoView({ block: 'nearest' });
    }}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-label={option.accessibleLabel ?? option.label}
          aria-selected={option.value === value}
          tabIndex={index === activeIndex ? 0 : -1}
          className={styles['picker-option']}
          data-testid={optionTestId}
          data-value={option.value}
          onFocus={() => setActiveValue(option.value)}
          onClick={() => onSelect(option.value)}
        >
          {option.icon && <span className={styles['picker-option-icon']} aria-hidden="true">{option.icon}</span>}
          <span className={styles['picker-option-name']} title={option.label}>{option.label}</span>
          {option.detail && <span className={styles['picker-option-detail']}>{option.detail}</span>}
          {shouldShowSelectionMark && <span className={styles['picker-option-check']} aria-hidden="true">{option.value === value && <CheckOutlined />}</span>}
        </button>
      ))}
    </div>
  );
}
