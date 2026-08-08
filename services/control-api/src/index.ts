import { validateEnvironment } from '@agent-launchpad/shared';

export function createControlApiBoundary(environment: Record<string, string | undefined>) {
  return {
    environment: validateEnvironment(environment)
  };
}

export * from './http.js';
