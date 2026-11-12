import * as React from 'react';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center whitespace-nowrap border-0 font-medium select-none',
    'rounded-md transition-[background-color,color,box-shadow,transform,opacity] cursor-pointer',
    'focus-visible:outline-none focus-visible:shadow-focus',
    'active:enabled:scale-[0.97]',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:enabled:bg-primary-hover active:enabled:bg-primary-active shadow-control',
        active: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-brand hover:enabled:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_42%,transparent)]',
        secondary: 'bg-secondary text-secondary-foreground hover:enabled:bg-secondary-hover active:enabled:bg-secondary-active shadow-control',
        filled: 'bg-field text-foreground hover:enabled:bg-field-hover shadow-well',
        ghost: 'bg-transparent text-foreground hover:enabled:bg-secondary active:enabled:bg-secondary-hover shadow-none',
        dashed: 'border border-dashed border-border bg-transparent text-foreground hover:enabled:border-muted-foreground hover:enabled:bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] shadow-none',
        destructive: 'bg-destructive text-destructive-foreground hover:enabled:opacity-90 shadow-none',
        'destructive-secondary': 'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger hover:enabled:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--danger)_28%,transparent)]',
        'destructive-ghost': 'bg-transparent text-danger hover:enabled:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] shadow-none',
        link: 'h-auto px-0 py-0 bg-transparent text-brand hover:enabled:underline active:enabled:scale-100 shadow-none',
      },
      size: {
        default: 'h-8 px-3 text-base gap-1.5',
        sm: 'h-7 px-2.5 text-md gap-1.5',
        lg: 'h-9 px-4 text-base gap-2',
        icon: 'size-8 p-0 gap-0',
        'icon-sm': 'size-7 p-0 gap-0',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'title'>,
    VariantProps<typeof buttonVariants> {
  'data-tip'?: string;
  'data-tip-side'?: 'top' | 'bottom' | 'left' | 'right';
  'data-tip-overflow'?: string;
  type?: 'button' | 'submit' | 'reset';
  href?: string;
  target?: string;
  rel?: string;
  download?: string | boolean;
  icon?: React.ReactNode;
  iconPlacement?: 'start' | 'end';
  loading?: boolean;
  block?: boolean;
  danger?: boolean;
  render?: useRender.RenderProp;
  ref?: React.Ref<HTMLButtonElement | HTMLAnchorElement>;
}

function resolveDangerVariant(variant: ButtonVariant, danger: boolean | undefined): ButtonVariant {
  if (!danger) return variant;
  if (variant === 'primary' || variant === 'destructive') return 'destructive';
  if (variant === 'ghost' || variant === 'link') return 'destructive-ghost';
  return 'destructive-secondary';
}

export function Button({
  className,
  variant = 'secondary',
  size = 'default',
  type = 'button',
  href,
  target,
  rel,
  download,
  icon,
  iconPlacement = 'start',
  loading = false,
  block = false,
  danger = false,
  disabled = false,
  render,
  children,
  ref,
  ...props
}: ButtonProps) {
  const effectiveVariant = resolveDangerVariant(variant ?? 'secondary', danger);
  const hasChildren = children !== undefined && children !== null && children !== false && children !== '';
  const isIconOnly = !hasChildren && (Boolean(icon) || loading) && size !== 'icon' && size !== 'icon-sm';
  const effectiveSize: ButtonSize = isIconOnly
    ? (size === 'sm' ? 'icon-sm' : 'icon')
    : (size ?? 'default');
  const isDisabled = disabled || loading;
  const isAnchor = Boolean(href) && !render;

  const leadingGlyph = loading ? (
    <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
  ) : (
    icon ?? null
  );

  const glyphNode =
    leadingGlyph !== null && leadingGlyph !== undefined ? (
      <span data-slot="button-icon" className="inline-flex items-center justify-center shrink-0">
        {leadingGlyph}
      </span>
    ) : null;

  const content = (
    <>
      {iconPlacement === 'start' && glyphNode}
      {children}
      {iconPlacement === 'end' && glyphNode}
    </>
  );

  return useRender({
    defaultTagName: isAnchor ? 'a' : 'button',
    render,
    ref: ref as React.Ref<Element>,
    props: {
      'data-slot': 'button',
      'data-variant': effectiveVariant,
      'data-size': effectiveSize,
      'data-icon-only': effectiveSize === 'icon' || effectiveSize === 'icon-sm' ? '' : undefined,
      'data-danger': danger || effectiveVariant.startsWith('destructive') ? '' : undefined,
      ...(isAnchor
        ? {
            href: isDisabled ? undefined : href,
            target,
            rel,
            download,
            role: isDisabled ? 'link' : undefined,
            'aria-disabled': isDisabled || undefined,
            tabIndex: isDisabled ? -1 : props.tabIndex,
          }
        : {
            type: render ? undefined : type,
            disabled: render ? undefined : isDisabled,
            'aria-disabled': render && isDisabled ? true : undefined,
          }),
      'aria-busy': loading || undefined,
      className: cn(
        buttonVariants({ variant: effectiveVariant, size: effectiveSize }),
        block && 'w-full',
        isAnchor && 'no-underline',
        className,
      ),
      children: content,
      ...props,
    },
  });
}

export { buttonVariants };
