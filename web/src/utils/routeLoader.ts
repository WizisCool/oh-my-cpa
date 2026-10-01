// Navigation and intent signals share one import; a failed preload must not poison a later visit.
export function createRouteLoader<Module>(importModule: () => Promise<Module>): () => Promise<Module> {
  let pending: Promise<Module> | undefined;
  return () => {
    pending ??= importModule().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
