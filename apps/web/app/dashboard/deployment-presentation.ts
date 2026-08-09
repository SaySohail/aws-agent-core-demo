import type { DeploymentStage, DeploymentStatus } from '@agent-launchpad/schemas';

export type PresentedStageState = 'pending' | 'active' | 'succeeded' | 'failed';

export interface PresentedStage {
  readonly id: string;
  readonly label: string;
  readonly stages: readonly DeploymentStage[];
}

export const deploymentStages: readonly PresentedStage[] = [
  { id: 'configuration', label: 'Validate configuration', stages: ['VALIDATING'] },
  {
    id: 'environment',
    label: 'Verify AWS environment',
    stages: [
      'VERIFYING_CUSTOMER_ACCESS',
      'PREFLIGHT_REGION',
      'PREFLIGHT_MODEL',
      'PREFLIGHT_IAM',
      'PREFLIGHT_STORAGE',
      'PREFLIGHT_AGENTCORE'
    ]
  },
  { id: 'artifact', label: 'Prepare deployment artifact', stages: ['ENSURING_ARTIFACT'] },
  {
    id: 'dependencies',
    label: 'Provision agent dependencies',
    stages: ['PROVISIONING_DEPENDENCIES', 'WAITING_FOR_DEPENDENCIES']
  },
  {
    id: 'runtime',
    label: 'Deploy AgentCore Runtime',
    stages: [
      'DEPLOYING_RUNTIME',
      'WAITING_FOR_RUNTIME',
      'PROMOTING_ENDPOINT',
      'WAITING_FOR_ENDPOINT'
    ]
  },
  { id: 'health', label: 'Verify runtime health', stages: ['HEALTH_CHECKING'] }
];

const stageLabels: Record<DeploymentStage, string> = {
  QUEUED: 'Queued',
  VALIDATING: 'Validate configuration',
  VERIFYING_CUSTOMER_ACCESS: 'Verify AWS account access',
  PREFLIGHT_REGION: 'Verify Region',
  PREFLIGHT_MODEL: 'Verify Bedrock model',
  PREFLIGHT_IAM: 'Verify IAM prerequisites',
  PREFLIGHT_STORAGE: 'Verify artifact storage',
  PREFLIGHT_AGENTCORE: 'Verify AgentCore prerequisites',
  ENSURING_ARTIFACT: 'Prepare deployment artifact',
  PROVISIONING_DEPENDENCIES: 'Provision agent dependencies',
  WAITING_FOR_DEPENDENCIES: 'Wait for dependencies',
  DEPLOYING_RUNTIME: 'Deploy AgentCore Runtime',
  WAITING_FOR_RUNTIME: 'Wait for Runtime',
  HEALTH_CHECKING: 'Verify runtime health',
  PROMOTING_ENDPOINT: 'Promote production endpoint',
  WAITING_FOR_ENDPOINT: 'Wait for production endpoint',
  READY: 'Deployment ready',
  FAILED: 'Deployment failed'
};

export function stageLabel(stage: string): string {
  return stageLabels[stage as DeploymentStage] ?? `Deployment stage: ${stage}`;
}

export function deploymentStatusLabel(status: DeploymentStatus): string {
  return status === 'IN_PROGRESS' ? 'In progress' : status[0] + status.slice(1).toLowerCase();
}

export function isTerminal(status: DeploymentStatus): boolean {
  return status === 'READY' || status === 'FAILED';
}

export function presentedStageState(
  presented: PresentedStage,
  currentStage: DeploymentStage,
  status: DeploymentStatus,
  completedStages: ReadonlySet<DeploymentStage>
): PresentedStageState {
  if (status === 'FAILED' && presented.stages.includes(currentStage)) return 'failed';
  if (presented.stages.includes(currentStage) && !isTerminal(status)) return 'active';
  if (presented.stages.some((stage) => completedStages.has(stage)) || status === 'READY')
    return 'succeeded';
  return 'pending';
}
