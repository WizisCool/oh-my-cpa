import React from 'react';
import NumberFlow from '@number-flow/react';
import { MOTION_ROLL, MOTION_ROLL_PRESENCE } from '../../theme/themeConfig';
import type { RollingReadout } from '../../types/rollingNumber';

interface RollingNumberProps {
  /** The readout to print; undefined is the console's "no reading" mark. */
  readout: RollingReadout | undefined;
}

/**
 * RollingNumber prints a readout and sweeps it to the next one.
 *
 * The motion it runs is §7 rule 8's whole scope: the six dashboard KPI numbers, and nothing else in
 * the console. The timings are the `roll` and glyph-presence tokens from `themeConfig.ts`, so the
 * exception is a named token rather than a duration buried in a component.
 *
 * Everything it knows about the number comes from the readout, which the formatting layer derived
 * from the formatter that owns that reading - so this component decides *how* a value moves and
 * never what it says.
 *
 * Two behaviours are deliberate rather than inherited:
 *
 * - **A unit change prints in place.** `en-compact` and `zh` print a different unit word at a
 *   different magnitude, and a tile sliding from `1.2B` to `900M` would otherwise roll 1.2 into 900
 *   while the unit swapped underneath - digits that never described the window on their own. The
 *   frame where the unit word changes is therefore not animated; the next same-unit change sweeps
 *   normally.
 * - **Reduced motion wins.** `respectMotionPreference` is left at its default, so §7's
 *   `prefers-reduced-motion` override reaches the readout as well: the value still updates, it just
 *   arrives instead of travelling.
 *
 * The locale is pinned to `en` because that is what every formatter in this console prints in;
 * leaving it unset would silently follow the browser instead.
 */
export const RollingNumber: React.FC<RollingNumberProps> = ({ readout }) => {
  const suffix = readout?.suffix ?? '';
  const previousSuffix = React.useRef(suffix);
  // The ref is advanced in an effect rather than during render so a StrictMode
  // double render compares the same pair of readings twice and both passes agree.
  const unitChanged = previousSuffix.current !== suffix;
  React.useEffect(() => {
    previousSuffix.current = suffix;
  }, [suffix]);

  if (!readout) {
    // The console's shared "no reading" mark. A missing reading is not a zero reading - "nothing
    // measured" and "measured as nothing" are different claims - which is what the formatting
    // layer's own em dash already says on the surfaces that cannot animate.
    return <>—</>;
  }

  return (
    <NumberFlow
      value={readout.number}
      locales="en"
      format={readout.format}
      prefix={readout.prefix}
      suffix={readout.suffix}
      animated={!unitChanged}
      transformTiming={MOTION_ROLL}
      spinTiming={MOTION_ROLL}
      opacityTiming={MOTION_ROLL_PRESENCE}
    />
  );
};
