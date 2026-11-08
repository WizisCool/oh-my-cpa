import React from 'react';
import clsx from 'clsx';
import styles from './MaskedText.module.css';

export interface MaskedTextProps {
  /** The text a surface prints while the value is hidden. */
  masked: string;
  /** The full value a click reveals. */
  value: string;
  /** What a click does, for the hover title and assistive technology. */
  revealLabel: string;
  hideLabel: string;
  className?: string;
}

/**
 * A label that hides part of itself until the operator asks for it.
 *
 * The caller derives both forms: a surface masks what it may print (`maskAccount`, `maskKeyText`)
 * and only one that holds the full value can offer a reveal. Request records carry a mask but no
 * value, so they never reveal; a credential row and a routing card hold both, so they do. The whole
 * label is the toggle, so a mask reads as text rather than as a field with a control beside it.
 *
 * The two forms share one shape, so revealing moves nothing around it.
 */
export function MaskedText({ masked, value, revealLabel, hideLabel, className }: MaskedTextProps) {
  const [isRevealed, setIsRevealed] = React.useState(false);
  const [form, setForm] = React.useState({ masked, value });
  // A form that changed is a different thing to reveal: a reveal kept across the change would print
  // a value nobody asked for. Adjusting during render keeps that render out of the commit.
  if (form.masked !== masked || form.value !== value) {
    setForm({ masked, value });
    setIsRevealed(false);
  }
  if (masked === value) return <span className={className}>{value}</span>;
  const label = isRevealed ? hideLabel : revealLabel;
  return (
    <button
      type="button"
      className={clsx(styles['toggle'], className)}
      aria-pressed={isRevealed}
      title={label}
      // A mask inside a draggable card or row takes its own pointer: without this, pressing it
      // would start the drag instead of the reveal.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => setIsRevealed((shown) => !shown)}
    >
      {isRevealed ? value : masked}
    </button>
  );
}
