import React from 'react';

export interface RouteLoader<Module> {
  (): Promise<Module>;
  /** The module once its import has settled, so a render can use it without suspending. */
  loaded(): Module | undefined;
}

// Navigation and intent signals share one import; a failed preload must not poison a later visit.
export function createRouteLoader<Module>(importModule: () => Promise<Module>): RouteLoader<Module> {
  let pending: Promise<Module> | undefined;
  let module: Module | undefined;
  const load = () => {
    pending ??= importModule().then((value) => {
      module = value;
      return value;
    }, (error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  return Object.assign(load, { loaded: () => module });
}

/**
 * Wraps a named module export in a deduplicated `RouteLoader` shared by preloads and lazy boundaries.
 */
export function createNamedLoader<Module, Name extends keyof Module>(
  importModule: () => Promise<Module>,
  name: Name,
): RouteLoader<{ default: Module[Name] }> {
  return createRouteLoader(async () => ({ default: (await importModule())[name] }));
}

/**
 * A lazy component that renders at once when intent or idle prewarming already settled its module.
 *
 * `React.lazy` suspends on its first render even when the import has settled, so a preloaded page
 * or chart would still paint its loading frame - and React holds a revealed fallback for up to half
 * a second. The component chosen on mount is kept, so one that did suspend is not remounted when its
 * module arrives.
 */
export function lazyRoute<Props extends object = Record<string, never>>(
  load: RouteLoader<{ default: React.ComponentType<Props> }>,
): React.FC<Props> {
  const LazyPage = React.lazy(load);
  return function RoutePage(props: Props) {
    const [module] = React.useState(load.loaded);
    const Target = (module?.default ?? LazyPage) as React.ComponentType<Props>;
    return React.createElement(Target, props);
  };
}
