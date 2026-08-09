import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type CloudFormationClient
} from '@aws-sdk/client-cloudformation';
import type { CustomerRoleAssumer, ControlPlaneRepository } from '@agent-launchpad/aws';
import type { Deployment } from '@agent-launchpad/schemas';
import {
  DeploymentError,
  type DeploymentCommandInput,
  type DependencyProvisioner,
  type UndeployDependencyPort
} from './index.js';

type CloudFormation = Pick<CloudFormationClient, 'send'>;

/** An opaque ID is normalized, then fixed forever; retries and redrives target this same stack. */
export function dependencyStackName(agentId: string): string {
  return `AgentLaunchpadAgent-${agentId.replace(/[^A-Za-z0-9]/g, '').slice(-48)}`;
}

export class CloudFormationDependencyProvisioner
  implements DependencyProvisioner, UndeployDependencyPort
{
  public constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly assumer: CustomerRoleAssumer,
    private readonly templateUrl: string | undefined,
    private readonly clientFor: (input: {
      region: string;
      credentials: Awaited<ReturnType<CustomerRoleAssumer['assumeCustomerRole']>>;
    }) => CloudFormation,
    private readonly now: () => Date = () => new Date()
  ) {}

  async reconcile(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context, 'PROVISIONING_DEPENDENCIES');
    if (!this.templateUrl)
      throw new DeploymentError(
        'DEPENDENCY_TEMPLATE_UNCONFIGURED',
        'PROVISIONING_DEPENDENCIES',
        false,
        'The agent dependency template URL is not configured.'
      );
    const stackName = dependencyStackName(resolved.deployment.agentId);
    const client = await this.client(resolved.deployment);
    const stack = await this.describe(client, stackName);
    if (!stack) {
      await client.send(
        new CreateStackCommand({
          StackName: stackName,
          TemplateURL: this.templateUrl,
          Capabilities: ['CAPABILITY_NAMED_IAM'],
          Tags: this.tags(resolved.deployment)
        })
      );
      return 'PENDING' as const;
    }
    if (/_(FAILED|ROLLBACK_COMPLETE)$/.test(stack.StackStatus ?? '')) return 'FAILED' as const;
    if (stack.StackStatus === 'CREATE_COMPLETE' || stack.StackStatus === 'UPDATE_COMPLETE')
      return this.persistOutput(resolved.deployment, stackName, stack);
    if (stack.StackStatus === 'UPDATE_IN_PROGRESS' || stack.StackStatus === 'CREATE_IN_PROGRESS')
      return 'PENDING' as const;
    try {
      await client.send(
        new UpdateStackCommand({
          StackName: stackName,
          TemplateURL: this.templateUrl,
          Capabilities: ['CAPABILITY_NAMED_IAM'],
          Tags: this.tags(resolved.deployment)
        })
      );
    } catch (cause) {
      if (!(cause instanceof Error) || !/No updates are to be performed/i.test(cause.message))
        throw this.error(cause, 'PROVISIONING_DEPENDENCIES');
    }
    return 'PENDING' as const;
  }

  async getStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context, 'WAITING_FOR_DEPENDENCIES');
    const stack = await this.describe(
      await this.client(resolved.deployment),
      dependencyStackName(resolved.deployment.agentId)
    );
    if (!stack) return 'FAILED' as const;
    if (stack.StackStatus === 'CREATE_COMPLETE' || stack.StackStatus === 'UPDATE_COMPLETE')
      return this.persistOutput(
        resolved.deployment,
        dependencyStackName(resolved.deployment.agentId),
        stack
      );
    return /_(FAILED|ROLLBACK_COMPLETE)$/.test(stack.StackStatus ?? '')
      ? ('FAILED' as const)
      : ('PENDING' as const);
  }

  async compensate(context: DeploymentCommandInput): Promise<void> {
    // Only this deployment's deterministic agent stack is eligible; bootstrap/shared resources are never named here.
    await this.delete(context);
  }

  async delete(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context, 'UNDEPLOY_DELETING_DEPENDENCIES');
    const name = resolved.deployment.cleanupPlan?.dependencyStackName;
    if (!name || name !== dependencyStackName(resolved.deployment.agentId))
      throw new DeploymentError(
        'RESOURCE_OWNERSHIP_MISMATCH',
        'UNDEPLOY_DELETING_DEPENDENCIES',
        false,
        'Dependency stack ownership validation failed.'
      );
    const client = await this.client(resolved.deployment);
    const stack = await this.describe(client, name);
    if (!stack) return 'READY' as const;
    if (stack.StackStatus === 'DELETE_COMPLETE') return 'READY' as const;
    if (stack.StackStatus === 'DELETE_FAILED') return 'FAILED' as const;
    if (stack.StackStatus !== 'DELETE_IN_PROGRESS')
      await client.send(new DeleteStackCommand({ StackName: name }));
    return 'PENDING' as const;
  }

  async getDeletionStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context, 'UNDEPLOY_WAITING_DEPENDENCIES');
    const name = resolved.deployment.cleanupPlan?.dependencyStackName;
    if (!name || name !== dependencyStackName(resolved.deployment.agentId))
      throw new DeploymentError(
        'RESOURCE_OWNERSHIP_MISMATCH',
        'UNDEPLOY_WAITING_DEPENDENCIES',
        false,
        'Dependency stack ownership validation failed.'
      );
    const stack = await this.describe(await this.client(resolved.deployment), name);
    if (!stack || stack.StackStatus === 'DELETE_COMPLETE') return 'READY' as const;
    return stack.StackStatus === 'DELETE_FAILED' ? ('FAILED' as const) : ('PENDING' as const);
  }

  private async resolve(context: DeploymentCommandInput, stage: DeploymentError['stage']) {
    const deployment = await this.repository.getDeployment(context.tenantId, context.deploymentId);
    const connection =
      deployment &&
      (await this.repository.getAwsConnection(
        context.tenantId,
        deployment.snapshot.awsConnectionId
      ));
    if (
      !deployment ||
      deployment.agentId !== context.agentId ||
      !connection ||
      connection.status !== 'VERIFIED' ||
      connection.accountId !== deployment.snapshot.accountId ||
      connection.region !== deployment.snapshot.region
    )
      throw new DeploymentError(
        'RESOURCE_OWNERSHIP_MISMATCH',
        stage,
        false,
        'Trusted dependency ownership validation failed.'
      );
    return { deployment, connection };
  }
  private async client(deployment: Deployment) {
    const connection = await this.repository.getAwsConnection(
      deployment.tenantId,
      deployment.snapshot.awsConnectionId
    );
    if (!connection)
      throw new DeploymentError(
        'CUSTOMER_ACCESS_REVOKED',
        'PREFLIGHT_IAM',
        false,
        'Customer access is unavailable.'
      );
    const credentials = await this.assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `dependencies-${deployment.id}`
    });
    return this.clientFor({ region: deployment.snapshot.region, credentials });
  }
  private async describe(client: CloudFormation, name: string) {
    try {
      return (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    } catch (cause) {
      if (cause instanceof Error && /does not exist|not exist/i.test(cause.message))
        return undefined;
      throw this.error(cause, 'WAITING_FOR_DEPENDENCIES');
    }
  }
  private async persistOutput(
    deployment: Deployment,
    name: string,
    stack: {
      Outputs?: { OutputKey?: string | undefined; OutputValue?: string | undefined }[] | undefined;
    }
  ) {
    const outputs = Object.fromEntries(
      (stack.Outputs ?? []).flatMap((output) =>
        output.OutputKey && output.OutputValue ? [[output.OutputKey, output.OutputValue]] : []
      )
    );
    if (!outputs.GatewayArn || !outputs.GatewayUrl) return 'FAILED' as const;
    await this.repository.setDeploymentDependencyOutput({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      dependencyStackName: name,
      gatewayArn: outputs.GatewayArn,
      gatewayUrl: outputs.GatewayUrl
    });
    return 'READY' as const;
  }
  private tags(deployment: Deployment) {
    return [
      { Key: 'ManagedBy', Value: 'AgentLaunchpad' },
      { Key: 'Plane', Value: 'DataPlane' },
      { Key: 'AgentId', Value: deployment.agentId },
      { Key: 'DeploymentId', Value: deployment.id }
    ];
  }
  private error(cause: unknown, stage: DeploymentError['stage']) {
    const name = cause instanceof Error ? cause.name : '';
    return new DeploymentError(
      /Throttl|Timeout|Internal|ServiceUnavailable/.test(name)
        ? 'CLOUDFORMATION_TRANSIENT'
        : 'CLOUDFORMATION_OPERATION_FAILED',
      stage,
      /Throttl|Timeout|Internal|ServiceUnavailable/.test(name),
      'CloudFormation operation failed.'
    );
  }
}
