export interface DeploymentErrorPresentation {
  readonly title: string;
  readonly description: string;
  readonly action: string;
}

const catalogue: Record<string, DeploymentErrorPresentation> = {
  MODEL_ACCESS_UNAVAILABLE: {
    title: 'Model access is unavailable',
    description: 'The selected model is not available for this deployment target.',
    action: 'Update the agent configuration or enable access to the selected model.'
  },
  CUSTOMER_ACCESS_REVOKED: {
    title: 'AWS account access needs reconnection',
    description: 'The customer AWS connection is no longer verified.',
    action: 'Reconnect and verify the AWS account before starting a new deployment.'
  },
  CUSTOMER_ACCOUNT_MISMATCH: {
    title: 'AWS account does not match the deployment target',
    description:
      'The verified AWS connection did not resolve to the account stored in this deployment snapshot.',
    action: 'Reconnect the intended AWS account before starting a new deployment.'
  },
  UNSUPPORTED_REGION: {
    title: 'Region is not supported',
    description:
      'The deployment target Region is not supported by the selected runtime configuration.',
    action: 'Choose a supported Region in the agent configuration.'
  },
  ARTIFACT_INTEGRITY_ERROR: {
    title: 'Deployment artifact could not be verified',
    description:
      'The immutable artifact for this deployment is unavailable or did not pass integrity checks.',
    action: 'Review the agent configuration and start a new deployment.'
  },
  BOOTSTRAP_INCOMPATIBLE: {
    title: 'AWS bootstrap needs an update',
    description: 'The connected AWS account does not have the required bootstrap capabilities.',
    action: 'Update and verify the AWS bootstrap stack, then start a new deployment.'
  },
  AGENTCORE_ACCESS_DENIED: {
    title: 'AgentCore access was denied',
    description:
      'The deployment role does not have the required AgentCore access for this operation.',
    action: 'Review the customer bootstrap permissions and start a new deployment.'
  },
  AGENTCORE_SERVICE_QUOTA: {
    title: 'AgentCore service quota was reached',
    description: 'The target AWS account has reached a service limit for this operation.',
    action: 'Request or free capacity, then start a new deployment.'
  },
  AGENTCORE_VALIDATION_ERROR: {
    title: 'AgentCore rejected the runtime configuration',
    description: 'The runtime request was not accepted by AgentCore.',
    action: 'Review the agent configuration and start a new deployment.'
  },
  AGENTCORE_THROTTLED: {
    title: 'AWS service is temporarily busy',
    description: 'The deployment encountered a transient AgentCore service condition.',
    action: 'Retry this exact deployment when ready.'
  },
  DEPLOYMENT_SNAPSHOT_INVALID: {
    title: 'Deployment snapshot is no longer valid',
    description:
      'The immutable configuration or target data required by this deployment could not be validated.',
    action: 'Review the agent configuration and start a new deployment.'
  }
};

export function deploymentError(code: string | undefined): DeploymentErrorPresentation {
  return (
    (code ? catalogue[code] : undefined) ?? {
      title: 'Deployment failed',
      description: 'The deployment could not be completed safely.',
      action:
        'Review the failed stage and contact support with the deployment ID if the issue persists.'
    }
  );
}
