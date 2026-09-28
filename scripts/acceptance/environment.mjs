import { devNull } from 'node:os';

export function isolatedAppEnvironment(overrides, inherited = process.env) {
  // The platform environment is needed to run a binary, but application settings
  // and transport proxies must come from the fixture rather than the operator.
  const environment = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    !/^OMCPA_/i.test(name) && !/^(?:PORT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name),
  ));
  return { ...environment, ...overrides, OMCPA_ENV_FILE: devNull };
}
