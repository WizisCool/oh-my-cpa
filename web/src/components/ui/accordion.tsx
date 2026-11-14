import * as React from 'react';
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { cn } from '@/lib/utils';
import { DropdownCaret } from '@/components/ui/dropdown-caret';

export interface CollapseItem {
  key: string;
  label: React.ReactNode;
  children: React.ReactNode;
  extra?: React.ReactNode;
  disabled?: boolean;
}

export type CollapseVariant = 'grouped' | 'cards' | 'ghost';

export interface CollapseProps {
  items: CollapseItem[];
  activeKey?: string | string[];
  defaultActiveKey?: string | string[];
  onChange?: (keys: string[]) => void;
  ghost?: boolean;
  variant?: CollapseVariant;
  size?: 'small' | 'middle' | 'large';
  className?: string;
}

function toKeyArray(keys?: string | string[]): string[] | undefined {
  if (keys === undefined) return undefined;
  return Array.isArray(keys) ? keys : [keys];
}

export function Collapse({
  items,
  activeKey,
  defaultActiveKey,
  onChange,
  ghost = false,
  variant,
  size = 'middle',
  className,
}: CollapseProps) {
  const resolvedVariant: CollapseVariant = variant ?? (ghost ? 'ghost' : 'grouped');
  const isGhost = resolvedVariant === 'ghost';
  const isCards = resolvedVariant === 'cards';

  return (
    <AccordionPrimitive.Root
      multiple
      value={toKeyArray(activeKey)}
      defaultValue={toKeyArray(defaultActiveKey)}
      onValueChange={(next) => onChange?.(next.map(String))}
      data-slot="accordion"
      data-variant={resolvedVariant}
      className={cn(
        'flex w-full flex-col',
        isGhost
          ? 'gap-1'
          : isCards
            ? 'gap-3'
            : 'divide-y divide-border-soft rounded-lg bg-surface shadow-edge',
        className,
      )}
    >
      {items.map((item) => (
        <AccordionPrimitive.Item
          key={item.key}
          value={item.key}
          disabled={item.disabled}
          data-slot="accordion-item"
          className={cn(
            'group/acc flex flex-col',
            isCards && 'rounded-xl bg-surface shadow-edge',
          )}
        >
          <AccordionPrimitive.Header className="m-0 flex items-center justify-between gap-2">
            <AccordionPrimitive.Trigger
              data-slot="accordion-trigger"
              className={cn(
                'group/trigger flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 border-0 bg-transparent text-left text-base font-medium text-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:shadow-focus [@media(pointer:coarse)]:min-h-10',
                isGhost
                  ? 'rounded-md px-1 py-2 hover:bg-hover-inset'
                  : isCards
                    ? 'rounded-xl px-4.5 py-3.5 data-[panel-open]:rounded-b-none'
                    : cn(
                        'group-first/acc:rounded-t-lg group-last/acc:rounded-b-lg group-last/acc:data-[panel-open]:rounded-b-none',
                        size === 'small' ? 'px-3 py-2.5 text-sm' : 'px-4 py-3',
                      ),
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <DropdownCaret className="-rotate-90 transition-transform duration-150 group-data-[panel-open]/trigger:rotate-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </span>
            </AccordionPrimitive.Trigger>
            {item.extra ? <div className="shrink-0 pr-3">{item.extra}</div> : null}
          </AccordionPrimitive.Header>
          {/* The panel folds by its height, so its padding lives on the box inside it: padding on the
              panel itself would survive the fold and stall the last frames at the padding's height. */}
          <AccordionPrimitive.Panel
            data-slot="accordion-panel"
            className={cn(
              'omc-fold-panel text-base text-foreground',
              isCards && 'rounded-b-xl',
              !isGhost && !isCards && 'group-last/acc:rounded-b-lg',
            )}
          >
            <div className={isGhost ? 'px-1 pt-1 pb-2' : isCards ? 'p-4' : size === 'small' ? 'px-3 pt-1 pb-3' : 'px-4 pt-1 pb-4'}>
              {item.children}
            </div>
          </AccordionPrimitive.Panel>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}
