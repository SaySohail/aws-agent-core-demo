import { validateEnvironment } from '@agent-launchpad/shared';

export function createDeploymentWorkerBoundary(environment: Record<string, string | undefined>) {
  return { environment: validateEnvironment(environment), status: 'not-implemented' as const };
}
