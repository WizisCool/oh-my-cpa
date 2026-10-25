import type { Catalog } from '../../catalog';
import shell from './shell';
import agent from './agent';
import dashboard from './dashboard';
import insights from './insights';
import logs from './logs';
import usageEvents from './usageEvents';
import providers from './providers';
import authFiles from './authFiles';
import oauth from './oauth';
import quota from './quota';
import config from './config';
import resources from './resources';
import models from './models';
import pricing from './pricing';
import plugins from './plugins';
import system from './system';
import settings from './settings';

export default {
  ...shell,
  ...agent,
  ...dashboard,
  ...insights,
  ...logs,
  ...usageEvents,
  ...providers,
  ...authFiles,
  ...oauth,
  ...quota,
  ...config,
  ...resources,
  ...models,
  ...pricing,
  ...plugins,
  ...system,
  ...settings,
} satisfies Catalog;
