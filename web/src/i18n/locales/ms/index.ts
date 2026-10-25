import type { Catalog } from '../../catalog';
import agent from './agent';
import authFiles from './authFiles';
import config from './config';
import dashboard from './dashboard';
import insights from './insights';
import logs from './logs';
import models from './models';
import oauth from './oauth';
import plugins from './plugins';
import pricing from './pricing';
import providers from './providers';
import quota from './quota';
import resources from './resources';
import settings from './settings';
import shell from './shell';
import system from './system';
import usageEvents from './usageEvents';

export default {
  ...agent,
  ...authFiles,
  ...config,
  ...dashboard,
  ...insights,
  ...logs,
  ...models,
  ...oauth,
  ...plugins,
  ...pricing,
  ...providers,
  ...quota,
  ...resources,
  ...settings,
  ...shell,
  ...system,
  ...usageEvents,
} satisfies Catalog;
