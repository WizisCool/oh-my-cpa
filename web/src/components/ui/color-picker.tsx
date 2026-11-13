import * as React from 'react';
import { HexColorPicker } from 'react-colorful';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const HEX_PATTERN = /^#([0-9a-fA-F]{6})$/;

export interface ColorPickerProps {
  value: string;
  onChange?: (hex: string) => void;
  onChangeComplete?: (hex: string) => void;
  disabled?: boolean;
  showText?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function ColorPicker({
  value,
  onChange,
  onChangeComplete,
  disabled,
  showText = true,
  className,
  'aria-label': ariaLabel,
}: ColorPickerProps) {
  const normalized = value.startsWith('#') ? value.toLowerCase() : `#${value.toLowerCase()}`;
  const [open, setOpen] = React.useState(false);
  const [draftText, setDraftText] = React.useState(normalized);
  const dirtyRef = React.useRef(false);
  const latestHexRef = React.useRef(normalized);
  latestHexRef.current = normalized;

  React.useEffect(() => {
    setDraftText(normalized);
  }, [normalized]);

  const handleHexChange = (next: string) => {
    const clean = next.toLowerCase();
    dirtyRef.current = true;
    latestHexRef.current = clean;
    setDraftText(clean);
    onChange?.(clean);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && dirtyRef.current) {
          dirtyRef.current = false;
          onChangeComplete?.(latestHexRef.current);
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={ariaLabel}
        data-slot="color-picker-trigger"
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border-0 bg-field px-2.5 text-sm text-foreground shadow-well outline-none transition-[background-color,box-shadow] hover:enabled:bg-field-hover hover:enabled:shadow-field-hover focus-visible:shadow-field-focus disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-10',
          className,
        )}
      >
        <span
          aria-hidden="true"
          style={{ backgroundColor: normalized }}
          className="size-4 shrink-0 rounded-xs shadow-[inset_0_0_0_1px_var(--fine-ring)]"
        />
        {showText ? <span className="font-mono text-sm tabular-nums">{normalized}</span> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[224px] p-3">
        <div
          className="flex flex-col gap-2.5"
          onPointerUp={() => {
            if (dirtyRef.current) {
              dirtyRef.current = false;
              onChangeComplete?.(latestHexRef.current);
            }
          }}
        >
          <HexColorPicker
            color={HEX_PATTERN.test(normalized) ? normalized : '#000000'}
            onChange={handleHexChange}
            style={{ width: '100%', height: 156 }}
          />
          <input
            type="text"
            value={draftText}
            maxLength={7}
            spellCheck={false}
            aria-label={ariaLabel ? `${ariaLabel} hex` : 'Hex color'}
            onChange={(e) => {
              const raw = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
              setDraftText(raw);
              if (HEX_PATTERN.test(raw)) {
                handleHexChange(raw);
              }
            }}
            onBlur={() => {
              if (HEX_PATTERN.test(draftText)) {
                onChangeComplete?.(draftText.toLowerCase());
                dirtyRef.current = false;
              } else {
                setDraftText(normalized);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && HEX_PATTERN.test(draftText)) {
                onChangeComplete?.(draftText.toLowerCase());
                dirtyRef.current = false;
                setOpen(false);
              }
            }}
            className="h-8 w-full rounded-md border-0 bg-field px-2.5 font-mono text-sm text-foreground shadow-well outline-none focus-visible:shadow-field-focus"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
