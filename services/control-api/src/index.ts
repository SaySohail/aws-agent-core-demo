import { agentLaunchRequestSchema } from '@agent-launchpad/schemas';
import { validateEnvironment } from '@agent-launchpad/shared';

export function createControlApiBoundary(environment: Record<string, string | undefined>) {
  return {
    environment: validateEnvironment(environment),
    launchContract: agentLaunchRequestSchema
  };
}
