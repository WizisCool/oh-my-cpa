import { getAppConfig } from './config';

/**
 * Whether this deployment is the public demonstration.
 *
 * It is read once from the configuration the server injected into the page, so
 * every caller in a render pass agrees with every other. The answer never changes
 * for the life of a page: the server decides it at start-up.
 */
export function isDemoMode(): boolean {
  return getAppConfig().demo;
}
