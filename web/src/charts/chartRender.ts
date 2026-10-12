import React from 'react';

/**
 * The pixel density every chart canvas is drawn at: the display's own, and never below 2.
 *
 * G draws a chart into a `<canvas>` sized from `window.devicePixelRatio`, so on a 1x display a
 * 1.6px line is rasterised straight onto the pixel grid and its steep sections step visibly - the
 * trend's peaks read as a saw. Drawing at 2x and letting the browser scale the bitmap down is
 * supersampling: the same geometry, with its edges averaged instead of snapped.
 */
export function chartPixelRatio(): number {
  const native = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.max(2, Math.ceil(native));
}

/** The structural part of a G renderer plugin this module needs. */
interface RendererPluginContext {
  config: { devicePixelRatio?: number };
}

/**
 * A G renderer plugin that pins the canvas's pixel density before the canvas is sized.
 *
 * Neither `@ant-design/plots` nor G2 forwards a pixel ratio to the canvas it creates, but both
 * forward `plugins`, and G initialises a renderer's plugins - handing each the canvas context -
 * *before* it creates the context service that sizes the bitmap from `config.devicePixelRatio`.
 * Setting the ratio here is therefore the ratio the canvas is created with, not a resize after it.
 */
const PLUGIN_CONTEXTS = new WeakMap<object, RendererPluginContext>();

class PixelRatioPlugin {
  readonly name = 'omc-pixel-ratio';

  constructor(private readonly ratio: number) {}

  // G assigns the canvas context to `plugin.context`. It is kept beside the plugin rather than on
  // it, for the same reason the list below is trimmed: the context is cyclic, and an own property
  // holding it would put the cycle back into the config the wrapper walks.
  get context(): RendererPluginContext | undefined {
    return PLUGIN_CONTEXTS.get(this);
  }

  set context(value: RendererPluginContext | undefined) {
    if (value) PLUGIN_CONTEXTS.set(this, value);
    else PLUGIN_CONTEXTS.delete(this);
  }

  init(): void {
    const context = this.context;
    if (context) context.config.devicePixelRatio = this.ratio;
  }

  destroy(): void {
    PLUGIN_CONTEXTS.delete(this);
  }
}

/**
 * The part of an `@ant-design/plots` instance the container fit needs. The wrapper types the
 * argument of `onReady` as G2's chart, but hands over its own plot, which holds both; the shape
 * is checked rather than assumed, so a wrapper that changes it loses the refit, not the chart.
 */
interface FittedChart {
  container: HTMLElement;
  triggerResize: () => void;
}

function isFittedChart(chart: unknown): chart is FittedChart {
  const candidate = chart as Partial<FittedChart> | null | undefined;
  return candidate?.container instanceof HTMLElement && typeof candidate.triggerResize === 'function';
}

/**
 * The plugin list one chart is created with, and the hooks that keep it clean and sized.
 *
 * G2 appends its own drag-and-drop plugin to the array it is handed, and G then gives that plugin
 * the canvas context - a cyclic graph. The chart wrapper walks its whole config on every render and
 * again when React's development mode re-runs the creating effect, and that walk has no cycle guard:
 * reaching the appended plugin overflowed the stack. `onReady` fires right after creation, once G2
 * has registered every plugin with its renderer, so trimming the array back to this module's own
 * entry there leaves the renderer complete and the config free of anything cyclic.
 *
 * `onReady` also keeps the canvas the size of its container. G2's `autoFit` refits only on a
 * window `resize`, so a container that changes size for any other reason - the console font
 * arriving after the first paint and re-measuring the text beside a chart, a side panel opening -
 * kept a canvas drawn for the old box: the model ring stayed inscribed in a smaller square than
 * its frame, and the total centred on the frame sat beside the hole. A `ResizeObserver` on the
 * chart's own container refits it whenever that box changes.
 */
export function useChartPlugins(): { plugins: unknown[]; onReady: (chart: unknown) => void } {
  const plugins = React.useMemo<unknown[]>(() => [new PixelRatioPlugin(chartPixelRatio())], []);
  const observerRef = React.useRef<ResizeObserver | null>(null);
  React.useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);
  const onReady = React.useCallback((chart: unknown) => {
    plugins.length = 1;
    // A development re-run of the creating effect makes a second chart; the first one's observer
    // must not outlive it.
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!isFittedChart(chart) || typeof ResizeObserver === 'undefined') return;
    // The first notification reports the size the chart was just drawn at; G2's refit is a no-op
    // when the size is unchanged, so it costs nothing.
    const observer = new ResizeObserver(() => chart.triggerResize());
    observer.observe(chart.container);
    observerRef.current = observer;
  }, [plugins]);
  return { plugins, onReady };
}
