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
 * The plugin list one chart is created with, and the hook that keeps it clean.
 *
 * G2 appends its own drag-and-drop plugin to the array it is handed, and G then gives that plugin
 * the canvas context - a cyclic graph. The chart wrapper walks its whole config on every render and
 * again when React's development mode re-runs the creating effect, and that walk has no cycle guard:
 * reaching the appended plugin overflowed the stack. `onReady` fires right after creation, once G2
 * has registered every plugin with its renderer, so trimming the array back to this module's own
 * entry there leaves the renderer complete and the config free of anything cyclic.
 */
export function useChartPlugins(): { plugins: unknown[]; onReady: () => void } {
  const plugins = React.useMemo<unknown[]>(() => [new PixelRatioPlugin(chartPixelRatio())], []);
  const onReady = React.useCallback(() => {
    plugins.length = 1;
  }, [plugins]);
  return { plugins, onReady };
}
