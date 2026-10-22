import { AGENT_MESSAGES } from './agent';
import { AUTH_FILES_MESSAGES } from './authFiles';
import { CONFIG_MESSAGES } from './config';
import { DASHBOARD_MESSAGES } from './dashboard';
import { LOGS_MESSAGES } from './logs';
import { MODELS_MESSAGES } from './models';
import { OAUTH_MESSAGES } from './oauth';
import { PLUGINS_MESSAGES } from './plugins';
import { PRICING_MESSAGES } from './pricing';
import { PROVIDERS_MESSAGES } from './providers';
import { QUOTA_MESSAGES } from './quota';
import { RESOURCES_MESSAGES } from './resources';
import { SETTINGS_MESSAGES } from './settings';
import { SHELL_MESSAGES } from './shell';
import { SYSTEM_MESSAGES } from './system';
import { USAGE_EVENTS_MESSAGES } from './usageEvents';
import type { Messages } from './types';

export type { Messages } from './types';

/**
 * The base dictionary: every message id with its [Simplified Chinese, English] pair. A
 * key lives in the file its prefix names, so a page's copy is found by its prefix; ids
 * are unique across files, which `pnpm check-i18n` enforces because a spread would
 * otherwise let a later file silently replace an earlier one's copy.
 */
export const DICT: Messages = {
  ...SHELL_MESSAGES,
  ...AGENT_MESSAGES,
  ...DASHBOARD_MESSAGES,
  ...LOGS_MESSAGES,
  ...USAGE_EVENTS_MESSAGES,
  ...PROVIDERS_MESSAGES,
  ...AUTH_FILES_MESSAGES,
  ...OAUTH_MESSAGES,
  ...QUOTA_MESSAGES,
  ...CONFIG_MESSAGES,
  ...RESOURCES_MESSAGES,
  ...MODELS_MESSAGES,
  ...PRICING_MESSAGES,
  ...PLUGINS_MESSAGES,
  ...SYSTEM_MESSAGES,
  ...SETTINGS_MESSAGES,
};
