import React from 'react';
import NumberFlow, { NumberFlowGroup } from '@number-flow/react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useFrameBudgetMount } from '../../performance/frameScheduler';
import { useIsRouteActive } from '../../performance/routeContract';
import { MOTION_ROLL, MOTION_ROLL_PRESENCE } from '../../theme/themeConfig';
import type { RollingReadout } from '../../types/rollingNumber';

export const RollingNumberGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isRouteActive = useIsRouteActive();
  const isGroupFlowMounted = useFrameBudgetMount('p2', { immediate: false, enabled: isRouteActive });
  return (
    <RollingGroupHydrationContext.Provider value={isGroupFlowMounted}>
      <NumberFlowGroup>{children}</NumberFlowGroup>
    </RollingGroupHydrationContext.Provider>
  );
};

const RollingGroupHydrationContext = React.createContext<boolean | null>(null);

const STATIC_FORMATTERS = new Map<string, Intl.NumberFormat>();

function formatReadoutStatic(readout: RollingReadout): string {
  const key = JSON.stringify(readout.format);
  let formatter = STATIC_FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en', readout.format);
    STATIC_FORMATTERS.set(key, formatter);
  }
  return `${readout.prefix ?? ''}${formatter.format(readout.number)}${readout.suffix ?? ''}`;
}

interface RollingNumberProps {
  /** The readout to print; undefined is the console's "no reading" mark. */
  readout: RollingReadout | undefined;
}

/**
 * RollingNumber prints a readout and sweeps it to the next one.
 *
 * Readout motion is scoped to the dashboard KPI numbers and the Insights headline tiles and token parts.
 * The timings are the `roll` and glyph-presence tokens from `themeConfig.ts`, so the
 * exception is a named token rather than a duration buried in a component.
 *
 * Everything it knows about the number comes from the readout, which the formatting layer derived
 * from the formatter that owns that reading - so this component decides *how* a value moves and
 * never what it says.
 *
 * Two behaviours are deliberate rather than inherited:
 *
 * - **A unit change prints in place.** Currency changes replace the leading mark; `en-compact` and `zh` print a different unit word at a
 *   different magnitude, and a tile sliding from `1.2B` to `900M` would otherwise roll 1.2 into 900
 *   while the unit swapped underneath - digits that never described the window on their own. The
 *   frame where the unit word changes is therefore not animated; the next same-unit change sweeps
 *   normally.
 * - **The console's motion policy wins.** NumberFlow's independent system check is disabled so an
 *   explicit console choice applies in either direction; reduced values update in place.
 *
 * The locale is pinned to `en` because that is what every formatter in this console prints in;
 * leaving it unset would silently follow the browser instead.
 */
const RollingNumberView: React.FC<RollingNumberProps> = ({ readout }) => {
  const isReducedMotion = usePrefersReducedMotion();
  const isRouteActive = useIsRouteActive();
  const groupHydrated = React.useContext(RollingGroupHydrationContext);
  const standaloneHydrated = useFrameBudgetMount('p2', {
    immediate: groupHydrated !== null,
    enabled: isRouteActive,
  });
  const isFlowMounted = groupHydrated ?? standaloneHydrated;
  const hasHydratedFlowRef = React.useRef(false);
  const unit = `${readout?.prefix ?? ''}\0${readout?.suffix ?? ''}`;
  const previousUnit = React.useRef(unit);
  // The ref is advanced in an effect rather than during render so a StrictMode
  // double render compares the same pair of readings twice and both passes agree.
  const unitChanged = previousUnit.current !== unit;
  React.useEffect(() => {
    previousUnit.current = unit;
  }, [unit]);
  React.useEffect(() => {
    if (isFlowMounted) hasHydratedFlowRef.current = true;
  }, [isFlowMounted]);

  if (!readout) {
    // The console's shared "no reading" mark. A missing reading is not a zero reading - "nothing
    // measured" and "measured as nothing" are different claims - which is what the formatting
    // layer's own em dash already says on the surfaces that cannot animate.
    return <>—</>;
  }

  // Paint the exact formatted text immediately on Frame 1 without Shadow DOM custom-element
  // construction or forced glyph layout; upgrade silently in a background `p2` slice so subsequent
  // live-tail or range changes sweep with batched `<NumberFlowGroup>` motion.
  if (isReducedMotion || !isFlowMounted) {
    return <>{formatReadoutStatic(readout)}</>;
  }

  return (
    <NumberFlow
      value={readout.number}
      locales="en"
      format={readout.format}
      prefix={readout.prefix}
      suffix={readout.suffix}
      animated={hasHydratedFlowRef.current && !unitChanged}
      respectMotionPreference={false}
      transformTiming={MOTION_ROLL}
      spinTiming={MOTION_ROLL}
      opacityTiming={MOTION_ROLL_PRESENCE}
    />
  );
};

function isSameFormat(a: RollingReadout['format'], b: RollingReadout['format']): boolean {
  const aKeys = Object.keys(a) as (keyof RollingReadout['format'])[];
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
}

/** Whether two readouts print the same reading: same number, marks and shape. */
export function isSameReadout(a: RollingReadout | undefined, b: RollingReadout | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.number === b.number && a.prefix === b.prefix && a.suffix === b.suffix && isSameFormat(a.format, b.format);
}

/**
 * Re-rendered only when the reading changes. A readout is built afresh on every render of the page
 * that owns it, and NumberFlow measures its glyphs - a forced layout of the whole page - on every
 * update it is handed, so an unrelated re-render (a filter, a chart's hover) used to cost a layout
 * per number on screen.
 */
export const RollingNumber = React.memo(RollingNumberView, (previous, next) => isSameReadout(previous.readout, next.readout));
