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
 * A lazy page that renders at once when intent already downloaded its module.
 *
 * `React.lazy` suspends on its first render even when the import has settled, so a preloaded page
 * would still paint its route's loading frame - and React holds a revealed fallback for up to half
 * a second. The page chosen on mount is kept, so a page that did suspend is not remounted when its
 * module arrives.
 */
export function lazyRoute(load: RouteLoader<{ default: React.ComponentType }>): React.FC {
  const LazyPage = React.lazy(load);
  return function RoutePage() {
    const [module] = React.useState(load.loaded);
    return React.createElement(module?.default ?? LazyPage);
  };
}
