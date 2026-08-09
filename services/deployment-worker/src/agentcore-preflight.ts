import {
  ListAgentRuntimesCommand,
  type BedrockAgentCoreControlClient
} from '@aws-sdk/client-bedrock-agentcore-control';
import type { ControlPlaneRepository, CustomerRoleAssumer } from '@agent-launchpad/aws';
import type { Deployment } from '@agent-launchpad/schemas';
import { DeploymentError, type AgentCorePreflightChecker } from './index.js';

type ControlClient = Pick<BedrockAgentCoreControlClient, 'send'>;

/**
 * Uses ListAgentRuntimes with a one-item page purely as an authorization and regional
 * availability probe. It never creates or modifies a customer resource.
 */
export class AgentCoreControlPlanePreflightChecker implements AgentCorePreflightChecker {
  public constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly assumer: CustomerRoleAssumer,
    private readonly createClient: (input: {
      region: string;
      credentials: Awaited<ReturnType<CustomerRoleAssumer['assumeCustomerRole']>>;
    }) => ControlClient
  ) {}

  async check(deployment: Deployment): Promise<void> {
    const connection = await this.repository.getAwsConnection(
      deployment.tenantId,
      deployment.snapshot.awsConnectionId
    );
    if (
      !connection ||
      connection.status !== 'VERIFIED' ||
      connection.accountId !== deployment.snapshot.accountId ||
      connection.region !== deployment.snapshot.region
    )
      throw new DeploymentError(
        'CUSTOMER_CONNECTION_INVALID',
        'PREFLIGHT_AGENTCORE',
        false,
        'The verified customer connection does not match the deployment target.'
      );
    const credentials = await this.assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `preflight-${deployment.id}`
    });
    try {
      await this.createClient({ region: deployment.snapshot.region, credentials }).send(
        new ListAgentRuntimesCommand({ maxResults: 1 })
      );
    } catch (cause) {
      throw agentCorePreflightError(cause);
    }
  }
}

export function agentCorePreflightError(cause: unknown): DeploymentError {
  const detail = cause as {
    name?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string };
  };
  const name = detail?.name ?? '';
  const requestId = detail?.$metadata?.requestId;
  if (name === 'AccessDeniedException' || name === 'AccessDenied')
    return new DeploymentError(
      'AGENTCORE_ACCESS_DENIED',
      'PREFLIGHT_AGENTCORE',
      false,
      'The customer deployment role is not authorized to read AgentCore Runtime resources.',
      requestId
    );
  if (
    name === 'UnknownEndpoint' ||
    name === 'EndpointConnectionError' ||
    name === 'UnrecognizedClientException' ||
    detail?.$metadata?.httpStatusCode === 404
  )
    return new DeploymentError(
      'AGENTCORE_REGION_UNAVAILABLE',
      'PREFLIGHT_AGENTCORE',
      false,
      'AgentCore Runtime is unavailable in the target Region.',
      requestId
    );
  if (name === 'ValidationException' || name === 'InvalidParameterException')
    return new DeploymentError(
      'AGENTCORE_PERMISSION_CONFIGURATION_INVALID',
      'PREFLIGHT_AGENTCORE',
      false,
      'The customer AgentCore permissions are invalid for this deployment.',
      requestId
    );
  return new DeploymentError(
    'AGENTCORE_PREFLIGHT_TRANSIENT_FAILURE',
    'PREFLIGHT_AGENTCORE',
    true,
    'AgentCore preflight could not be completed. Please retry.',
    requestId
  );
}
