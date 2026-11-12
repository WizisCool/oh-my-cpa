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

export interface CollapseProps {
  items: CollapseItem[];
  activeKey?: string | string[];
  defaultActiveKey?: string | string[];
  onChange?: (keys: string[]) => void;
  ghost?: boolean;
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
  size = 'middle',
  className,
}: CollapseProps) {
  return (
    <AccordionPrimitive.Root
      multiple
      value={toKeyArray(activeKey)}
      defaultValue={toKeyArray(defaultActiveKey)}
      onValueChange={(next) => onChange?.(next.map(String))}
      data-slot="accordion"
      className={cn(
        'flex w-full flex-col',
        ghost ? 'gap-1' : 'divide-y divide-border-soft overflow-hidden rounded-lg bg-surface shadow-edge',
        className,
      )}
    >
      {items.map((item) => (
        <AccordionPrimitive.Item
          key={item.key}
          value={item.key}
          disabled={item.disabled}
          data-slot="accordion-item"
          className="group/acc flex flex-col"
        >
          <AccordionPrimitive.Header className="m-0 flex items-center justify-between gap-2">
            <AccordionPrimitive.Trigger
              data-slot="accordion-trigger"
              className={cn(
                'group/trigger flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 border-0 bg-transparent text-left text-base font-medium text-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:shadow-focus [@media(pointer:coarse)]:min-h-10',
                ghost
                  ? 'rounded-md px-1 py-2 hover:bg-hover-inset'
                  : size === 'small'
                    ? 'px-3 py-2.5 text-sm'
                    : 'px-4 py-3',
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
            className="omc-fold-panel overflow-hidden text-base text-foreground"
          >
            <div className={ghost ? 'px-1 pt-1 pb-2' : size === 'small' ? 'px-3 pt-1 pb-3' : 'px-4 pt-1 pb-4'}>
              {item.children}
            </div>
          </AccordionPrimitive.Panel>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}
