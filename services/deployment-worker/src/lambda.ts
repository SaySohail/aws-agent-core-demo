import type { DeploymentStage } from '@agent-launchpad/schemas';
import { createDeploymentWorkerBoundary } from './index.js';

/**
 * Lambda transport boundary. Concrete repository/AWS adapters are deliberately injected by the
 * deployment-worker composition root so Stage Functions input stays identifiers-only.
 */
export async function handler(event: { stage: DeploymentStage }): Promise<{ status: 'PENDING' }> {
  createDeploymentWorkerBoundary(process.env);
  // SAY-100's runtime adapter is intentionally not present. Returning PENDING lets the bounded
  // Standard workflow poll instead of a Lambda blocking on a long-running customer operation.
  if (!event?.stage) throw new Error('Deployment stage is required.');
  return { status: 'PENDING' };
}
