import * as React from 'react';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '@/lib/utils';

const TabsRoot = TabsPrimitive.Root;

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'relative flex w-full items-center gap-1 overflow-x-auto border-b-[length:var(--hairline)] border-b-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex min-h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-t-md border-0 bg-transparent px-3 py-2 text-md font-medium whitespace-nowrap text-fg-2 outline-none transition-colors select-none [@media(pointer:coarse)]:min-h-10',
        'hover:not-data-[active]:bg-surface hover:text-foreground focus-visible:rounded-sm focus-visible:shadow-focus',
        'data-[active]:font-semibold data-[active]:text-foreground data-[active]:after:absolute data-[active]:after:inset-x-0 data-[active]:after:bottom-0 data-[active]:after:h-0.5 data-[active]:after:bg-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('outline-none', className)}
      {...props}
    />
  );
}

export interface TabItem {
  key: string;
  label: React.ReactNode;
  children?: React.ReactNode;
  disabled?: boolean;
  forceRender?: boolean;
}

export interface DeclarativeTabsProps {
  activeKey?: string;
  defaultActiveKey?: string;
  onChange?: (activeKey: string) => void;
  items: TabItem[];
  size?: 'small' | 'middle' | 'large';
  tabBarExtraContent?: React.ReactNode;
  destroyOnHidden?: boolean;
  className?: string;
  listClassName?: string;
}

function Tabs({
  activeKey,
  defaultActiveKey,
  onChange,
  items,
  size = 'middle',
  tabBarExtraContent,
  destroyOnHidden = false,
  className,
  listClassName,
}: DeclarativeTabsProps) {
  const hasPanels = items.some((item) => item.children !== undefined);
  return (
    <TabsRoot
      data-slot="tabs"
      value={activeKey}
      defaultValue={defaultActiveKey ?? items[0]?.key}
      onValueChange={(val) => onChange?.(String(val))}
      className={cn('flex flex-col', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b-[length:var(--hairline)] border-b-border">
        <TabsList className={cn('flex-1 border-b-0', listClassName)}>
          {items.map((item) => (
            <TabsTrigger
              key={item.key}
              value={item.key}
              disabled={item.disabled}
              className={cn(size === 'small' && 'min-h-8 px-3 py-1.5 text-md')}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabBarExtraContent ? <div className="shrink-0">{tabBarExtraContent}</div> : null}
      </div>
      {hasPanels
        ? items.map((item) => (
            <TabsContent
              key={item.key}
              value={item.key}
              keepMounted={Boolean(item.forceRender) && !destroyOnHidden}
              className="pt-3"
            >
              {item.children}
            </TabsContent>
          ))
        : null}
    </TabsRoot>
  );
}

export { Tabs, TabsRoot, TabsList, TabsTrigger, TabsContent };
