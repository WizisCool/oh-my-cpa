import { Rectangle } from 'recharts';
import { RADIUS } from '../theme/radius';

/**
 * Every bar in the console ends in the same cap: the `xs` corner on its free end, square where it
 * stands on the axis. A column's free end is its top; a row's is its right.
 */
export const COLUMN_CAP: [number, number, number, number] = [RADIUS.xs, RADIUS.xs, 0, 0];
export const ROW_CAP: [number, number, number, number] = [0, RADIUS.xs, RADIUS.xs, 0];

/** The datum field naming the series whose segment ends that datum's stack. */
export const STACK_CAP_KEY = '__cap';

/**
 * Names, on a stacked datum, the series that ends its bar: the last in stack order with a value.
 * The cap belongs to whichever series that is per datum - a fixed radius on the last series would
 * leave every bar it is absent from square.
 */
export function stackCapOf(datum: Record<string, unknown>, stackOrder: readonly string[]): string {
  let cap = '';
  for (const key of stackOrder) {
    if (Number(datum[key] ?? 0) > 0) cap = key;
  }
  return cap;
}

/** A stacked series' bar shape: capped on the data where it ends the stack, square elsewhere. */
export function stackCapShape(series: string, orientation: 'column' | 'row' = 'column') {
  const cap = orientation === 'column' ? COLUMN_CAP : ROW_CAP;
  return function StackSegment(shapeProps: unknown) {
    const bar = shapeProps as React.ComponentProps<typeof Rectangle> & { payload?: Record<string, unknown> };
    return <Rectangle {...bar} radius={bar.payload?.[STACK_CAP_KEY] === series ? cap : 0} />;
  };
}
