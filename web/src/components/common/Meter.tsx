import clsx from 'clsx';

export interface MeterProps {
  /** The reading, between 0 and `max`; anything outside is drawn at the nearer end. */
  value: number;
  max?: number;
  /**
   * The fill's colour, as a CSS colour - usually the token for the band the reading falls in.
   * Without one the fill is the secondary ink: a share of something, with no health to state.
   */
  color?: string;
  /** `thick` is for a meter that is the row's subject; the default sits under a figure it repeats. */
  size?: 'default' | 'thick';
  /**
   * Names the reading for assistive technology. A meter beside the same figure in text omits it
   * and is hidden instead, so the figure is not read twice.
   */
  label?: string;
  className?: string;
}

/**
 * A reading drawn as a share of a track.
 *
 * The fill does not animate: a quota or a success rate that slid into place would read as a
 * change the operator had caused.
 */
export function Meter({ value, max = 100, color, size = 'default', label, className }: MeterProps) {
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const semantics = label === undefined
    ? { 'aria-hidden': true as const }
    : { role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': Math.max(0, Math.min(max, value)) };
  return (
    <span {...semantics} className={clsx('meter', size === 'thick' && 'is-thick', className)}>
      <span className="meter-fill" style={{ width: `${share * 100}%`, background: color }} />
    </span>
  );
}
