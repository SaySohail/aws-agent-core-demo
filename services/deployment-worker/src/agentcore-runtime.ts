import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  CreateAgentRuntimeEndpointCommand,
  DeleteAgentRuntimeCommand,
  DeleteAgentRuntimeEndpointCommand,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  UpdateAgentRuntimeCommand,
  UpdateAgentRuntimeEndpointCommand,
  type AgentRuntimeArtifact
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  AGENT_ARTIFACT_ENTRY_POINT,
  AgentRuntimeInvoker,
  AgentCoreSecurityError,
  ControlPlaneRepository,
  customerArtifactBucketName,
  customerRuntimeExecutionRoleArn,
  validateRuntimeArn,
  validateWorkloadIdentityArn,
  type CustomerRoleAssumer
} from '@agent-launchpad/aws';
import {
  createRuntimeVersionId,
  type AgentArtifact,
  type AwsConnection,
  type Deployment,
  type RuntimeVersion
} from '@agent-launchpad/schemas';
import { createHash } from 'node:crypto';
import {
  DeploymentError,
  type DeploymentCommandInput,
  type RuntimeDeploymentPort
} from './index.js';

export const PRODUCTION_RUNTIME_ENDPOINT = 'production';
export const runtimeMetadataConfiguration = { requireMMDSV2: true } as const;
/** SDK 3.1106 serializer supports the current AgentCore field before its Create input declaration did. */
type CurrentCreateRuntimeInput = ConstructorParameters<typeof CreateAgentRuntimeCommand>[0] & {
  readonly metadataConfiguration: { readonly requireMMDSV2: true };
};

/** Stable, API-safe name derived solely from the opaque immutable agent ID. */
export function agentCoreRuntimeName(agentId: string): string {
  const normalized = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  return `agent-launchpad-${normalized}`.slice(0, 100).replace(/-+$/, '');
}

export function agentCoreClientToken(input: {
  deploymentId: string;
  operation: 'create' | 'update' | 'endpoint-create' | 'endpoint-update';
  artifactSha256: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.deploymentId}|${input.operation}|${input.artifactSha256}`)
    .digest('hex');
  return `al-${input.operation}-${digest}`;
}

export function rollbackClientToken(operationId: string, fromVersion: string, targetVersion: string): string {
  return `al-rollback-${createHash('sha256').update(`${operationId}|${fromVersion}|${targetVersion}`).digest('hex')}`;
}

export function undeployClientToken(operationId: string, resource: string): string {
  return `al-undeploy-${createHash('sha256').update(`${operationId}|${resource}`).digest('hex')}`;
}

/** Stable contract identifier: only versioned deployment inputs, never clocks or endpoint state. */
export function compatibilityFingerprint(deployment: Deployment): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        templateVersion: deployment.snapshot.templateVersion,
        gateway: deployment.snapshot.gatewayUrl ?? '',
        configurationRevision: deployment.configurationRevision,
        capabilities: [...deployment.snapshot.capabilities].sort(),
        guardrails: deployment.snapshot.guardrails
      })
    )
    .digest('hex');
}

type ControlClient = Pick<BedrockAgentCoreControlClient, 'send'>;

export class AgentCoreRuntimeDeploymentPort implements RuntimeDeploymentPort {
  public constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly assumer: CustomerRoleAssumer,
    private readonly createControlClient: (input: {
      region: string;
      credentials: Awaited<ReturnType<CustomerRoleAssumer['assumeCustomerRole']>>;
    }) => ControlClient = (input) => new BedrockAgentCoreControlClient(input),
    private readonly invoker = new AgentRuntimeInvoker(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async deployRuntime(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const existing = this.desiredCandidate(resolved.versions, resolved.deployment);
    if (existing)
      return {
        status: existing.state === 'FAILED' ? 'FAILED' : 'PENDING',
        runtimeArn: existing.runtimeArn,
        runtimeVersion: existing.runtimeVersion
      } as const;
    const credentials = await this.credentials(resolved.connection, resolved.deployment);
    const client = this.createControlClient({
      region: resolved.deployment.snapshot.region,
      credentials
    });
    const roleArn = customerRuntimeExecutionRoleArn(resolved.deployment.snapshot.accountId);
    const artifact = this.artifactRequest(resolved.artifact);
    try {
      const agent = resolved.agent;
      const response = agent.runtimeId
        ? await client.send(
            new UpdateAgentRuntimeCommand({
              agentRuntimeId: agent.runtimeId,
              agentRuntimeArtifact: artifact,
              roleArn,
              networkConfiguration: { networkMode: 'PUBLIC' },
              metadataConfiguration: runtimeMetadataConfiguration,
              environmentVariables: this.environment(resolved.deployment),
              clientToken: agentCoreClientToken({
                deploymentId: context.deploymentId,
                operation: 'update',
                artifactSha256: resolved.artifact.sha256
              })
            })
          )
        : await client.send(
            new CreateAgentRuntimeCommand({
              agentRuntimeName: agentCoreRuntimeName(agent.id),
              agentRuntimeArtifact: artifact,
              roleArn,
              networkConfiguration: { networkMode: 'PUBLIC' },
              metadataConfiguration: runtimeMetadataConfiguration,
              environmentVariables: this.environment(resolved.deployment),
              clientToken: agentCoreClientToken({
                deploymentId: context.deploymentId,
                operation: 'create',
                artifactSha256: resolved.artifact.sha256
              }),
              tags: {
                ManagedBy: 'AgentLaunchpad',
                Plane: 'DataPlane',
                Purpose: 'CustomerBootstrap'
              }
            } as CurrentCreateRuntimeInput)
          );
      const runtimeId = response.agentRuntimeId;
      const runtimeArn = response.agentRuntimeArn;
      const runtimeVersion = response.agentRuntimeVersion;
      const workloadIdentityArn = response.workloadIdentityDetails?.workloadIdentityArn;
      if (!runtimeId || !runtimeArn || !runtimeVersion || !workloadIdentityArn)
        throw new DeploymentError(
          'AGENTCORE_RESPONSE_INVALID',
          'DEPLOYING_RUNTIME',
          false,
          'AgentCore did not return complete runtime metadata.'
        );
      this.validateResponse(runtimeArn, workloadIdentityArn, resolved.connection);
      const timestamp = this.now().toISOString();
      await this.repository.createRuntimeVersion({
        id: createRuntimeVersionId(),
        tenantId: context.tenantId,
        agentId: context.agentId,
        deploymentId: context.deploymentId,
        runtimeId,
        runtimeArn,
        runtimeVersion,
        artifactId: resolved.artifact.id,
        artifactSha256: resolved.artifact.sha256,
        configurationRevision: context.configurationRevision,
        compatibilityFingerprint: compatibilityFingerprint(resolved.deployment),
        workloadIdentityArn,
        state: resolved.agent.runtimeId ? 'UPDATING' : 'CREATING',
        createdAt: timestamp,
        updatedAt: timestamp
      });
      return { status: 'PENDING' as const, runtimeArn, runtimeVersion };
    } catch (cause) {
      throw this.mapError(cause, 'DEPLOYING_RUNTIME');
    }
  }

  async getRuntimeDeploymentStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const candidate = this.requiredCandidate(resolved.versions, resolved.deployment);
    const client = this.createControlClient({
      region: resolved.deployment.snapshot.region,
      credentials: await this.credentials(resolved.connection, resolved.deployment)
    });
    try {
      const response = await client.send(
        new GetAgentRuntimeCommand({
          agentRuntimeId: candidate.runtimeId,
          agentRuntimeVersion: candidate.runtimeVersion
        })
      );
      if (response.agentRuntimeArn)
        this.validateResponse(
          response.agentRuntimeArn,
          response.workloadIdentityDetails?.workloadIdentityArn ?? candidate.workloadIdentityArn,
          resolved.connection
        );
      if (response.status === 'READY') {
        await this.repository.updateRuntimeVersionStatus(context.tenantId, candidate.id, {
          state: 'READY',
          updatedAt: this.now().toISOString()
        });
        return 'READY' as const;
      }
      if (
        response.status === 'CREATE_FAILED' ||
        response.status === 'UPDATE_FAILED' ||
        response.status === 'DELETING'
      ) {
        await this.repository.updateRuntimeVersionStatus(context.tenantId, candidate.id, {
          state: 'FAILED',
          updatedAt: this.now().toISOString()
        });
        return 'FAILED' as const;
      }
      return 'PENDING' as const;
    } catch (cause) {
      throw this.mapError(cause, 'WAITING_FOR_RUNTIME');
    }
  }

  async checkRuntimeHealth(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const candidate = this.requiredCandidate(resolved.versions, resolved.deployment);
    try {
      await this.invoker.invoke({
        runtimeArn: candidate.runtimeArn,
        payload: { prompt: 'health check: respond briefly without tools' },
        sessionId: `health-${context.deploymentId}`,
        credentials: await this.credentials(resolved.connection, resolved.deployment),
        connection: resolved.connection,
        qualifier: candidate.runtimeVersion
      });
      return 'READY' as const;
    } catch (cause) {
      throw this.mapError(cause, 'HEALTH_CHECKING');
    }
  }

  async promoteProductionEndpoint(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const candidate = this.requiredCandidate(resolved.versions, resolved.deployment);
    const client = this.createControlClient({
      region: resolved.deployment.snapshot.region,
      credentials: await this.credentials(resolved.connection, resolved.deployment)
    });
    try {
      let endpoint;
      try {
        endpoint = await client.send(
          new GetAgentRuntimeEndpointCommand({
            agentRuntimeId: candidate.runtimeId,
            endpointName: PRODUCTION_RUNTIME_ENDPOINT
          })
        );
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
      }
      const tokenOperation = endpoint ? 'endpoint-update' : 'endpoint-create';
      if (!endpoint || endpoint.targetVersion !== candidate.runtimeVersion) {
        const response = endpoint
          ? await client.send(
              new UpdateAgentRuntimeEndpointCommand({
                agentRuntimeId: candidate.runtimeId,
                endpointName: PRODUCTION_RUNTIME_ENDPOINT,
                agentRuntimeVersion: candidate.runtimeVersion,
                clientToken: agentCoreClientToken({
                  deploymentId: context.deploymentId,
                  operation: tokenOperation,
                  artifactSha256: candidate.artifactSha256
                })
              })
            )
          : await client.send(
              new CreateAgentRuntimeEndpointCommand({
                agentRuntimeId: candidate.runtimeId,
                name: PRODUCTION_RUNTIME_ENDPOINT,
                agentRuntimeVersion: candidate.runtimeVersion,
                clientToken: agentCoreClientToken({
                  deploymentId: context.deploymentId,
                  operation: tokenOperation,
                  artifactSha256: candidate.artifactSha256
                }),
                tags: {
                  ManagedBy: 'AgentLaunchpad',
                  Plane: 'DataPlane',
                  Purpose: 'CustomerBootstrap'
                }
              })
            );
        await this.repository.updateRuntimeVersionStatus(context.tenantId, candidate.id, {
          state: 'READY',
          endpointName: PRODUCTION_RUNTIME_ENDPOINT,
          endpointArn: response.agentRuntimeEndpointArn,
          endpointTargetVersion: response.targetVersion ?? candidate.runtimeVersion,
          updatedAt: this.now().toISOString()
        });
      }
      return 'PENDING' as const;
    } catch (cause) {
      throw this.mapError(cause, 'PROMOTING_ENDPOINT');
    }
  }

  async getProductionEndpointStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const candidate = this.requiredCandidate(resolved.versions, resolved.deployment);
    const client = this.createControlClient({
      region: resolved.deployment.snapshot.region,
      credentials: await this.credentials(resolved.connection, resolved.deployment)
    });
    try {
      const endpoint = await client.send(
        new GetAgentRuntimeEndpointCommand({
          agentRuntimeId: candidate.runtimeId,
          endpointName: PRODUCTION_RUNTIME_ENDPOINT
        })
      );
      if (
        endpoint.status === 'CREATE_FAILED' ||
        endpoint.status === 'UPDATE_FAILED' ||
        endpoint.status === 'DELETING'
      )
        return 'FAILED' as const;
      if (endpoint.status !== 'READY' || endpoint.liveVersion !== candidate.runtimeVersion)
        return 'PENDING' as const;
      if (!endpoint.agentRuntimeEndpointArn)
        throw new DeploymentError(
          'ENDPOINT_RESPONSE_INVALID',
          'WAITING_FOR_ENDPOINT',
          false,
          'AgentCore did not return an endpoint ARN.'
        );
      const updatedAt = this.now().toISOString();
      await this.repository.updateRuntimeVersionStatus(context.tenantId, candidate.id, {
        state: 'READY',
        endpointName: PRODUCTION_RUNTIME_ENDPOINT,
        endpointArn: endpoint.agentRuntimeEndpointArn,
        endpointTargetVersion: endpoint.targetVersion,
        endpointLiveVersion: endpoint.liveVersion,
        productionPromotedAt: updatedAt,
        updatedAt
      });
      await this.repository.promoteAgentRuntime({
        tenantId: context.tenantId,
        agentId: context.agentId,
        runtimeId: candidate.runtimeId,
        runtimeArn: candidate.runtimeArn,
        runtimeVersion: candidate.runtimeVersion,
        runtimeEndpoint: endpoint.agentRuntimeEndpointArn,
        runtimeEndpointName: PRODUCTION_RUNTIME_ENDPOINT,
        runtimeWorkloadIdentityArn: candidate.workloadIdentityArn,
        updatedAt
      });
      return 'READY' as const;
    } catch (cause) {
      throw this.mapError(cause, 'WAITING_FOR_ENDPOINT');
    }
  }

  async rollbackProductionEndpoint(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const target = this.rollbackTarget(resolved.versions, resolved.deployment, resolved.agent.runtimeId);
    const client = this.createControlClient({ region: resolved.deployment.snapshot.region, credentials: await this.credentials(resolved.connection, resolved.deployment) });
    try {
      const endpoint = await client.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId: target.runtimeId, endpointName: PRODUCTION_RUNTIME_ENDPOINT }));
      if (endpoint.status !== 'READY' || endpoint.liveVersion !== resolved.deployment.fromRuntimeVersion)
        throw new DeploymentError('PRODUCTION_ENDPOINT_DRIFT', 'ROLLBACK_VALIDATING', false, 'Production endpoint state changed.');
      const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: target.runtimeId, agentRuntimeVersion: target.runtimeVersion }));
      if (runtime.status !== 'READY') throw new DeploymentError('ROLLBACK_TARGET_NOT_READY', 'ROLLBACK_VERIFYING_TARGET', false, 'Rollback target is not ready.');
      await client.send(new UpdateAgentRuntimeEndpointCommand({
        agentRuntimeId: target.runtimeId, endpointName: PRODUCTION_RUNTIME_ENDPOINT, agentRuntimeVersion: target.runtimeVersion,
        clientToken: rollbackClientToken(context.deploymentId, resolved.deployment.fromRuntimeVersion!, target.runtimeVersion)
      }));
      return 'PENDING' as const;
    } catch (cause) { throw this.mapError(cause, 'ROLLBACK_UPDATING_ENDPOINT'); }
  }

  async getRollbackStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const target = this.rollbackTarget(resolved.versions, resolved.deployment, resolved.agent.runtimeId);
    const client = this.createControlClient({ region: resolved.deployment.snapshot.region, credentials: await this.credentials(resolved.connection, resolved.deployment) });
    try {
      const endpoint = await client.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId: target.runtimeId, endpointName: PRODUCTION_RUNTIME_ENDPOINT }));
      if (endpoint.status === 'UPDATE_FAILED' || endpoint.status === 'DELETING') return 'FAILED' as const;
      return endpoint.status === 'READY' && endpoint.liveVersion === target.runtimeVersion ? 'READY' as const : 'PENDING' as const;
    } catch (cause) { throw this.mapError(cause, 'ROLLBACK_WAITING_FOR_ENDPOINT'); }
  }

  async checkRollbackHealth(context: DeploymentCommandInput) {
    const resolved = await this.resolve(context);
    const target = this.rollbackTarget(resolved.versions, resolved.deployment, resolved.agent.runtimeId);
    try {
      await this.invoker.invoke({ runtimeArn: target.runtimeArn, payload: { prompt: 'health check: respond briefly without tools' }, sessionId: `rollback-${context.deploymentId}`, credentials: await this.credentials(resolved.connection, resolved.deployment), connection: resolved.connection, qualifier: PRODUCTION_RUNTIME_ENDPOINT });
      const updatedAt = this.now().toISOString();
      await this.repository.updateRuntimeVersionStatus(context.tenantId, target.id, { state: 'READY', endpointName: PRODUCTION_RUNTIME_ENDPOINT, endpointLiveVersion: target.runtimeVersion, productionPromotedAt: updatedAt, updatedAt });
      await this.repository.promoteAgentRuntime({ tenantId: context.tenantId, agentId: context.agentId, runtimeId: target.runtimeId, runtimeArn: target.runtimeArn, runtimeVersion: target.runtimeVersion, runtimeEndpoint: resolved.agent.runtimeEndpoint!, runtimeEndpointName: PRODUCTION_RUNTIME_ENDPOINT, runtimeWorkloadIdentityArn: target.workloadIdentityArn, updatedAt });
      return 'READY' as const;
    } catch (cause) { throw this.mapError(cause, 'ROLLBACK_HEALTH_CHECKING'); }
  }

  async deleteProductionEndpoint(context: DeploymentCommandInput) {
    const resolved = await this.resolveUndeploy(context, 'UNDEPLOY_DELETING_ENDPOINT');
    const client = this.createControlClient({ region: resolved.deployment.snapshot.region, credentials: await this.credentials(resolved.connection, resolved.deployment) });
    try {
      await client.send(new DeleteAgentRuntimeEndpointCommand({
        agentRuntimeId: resolved.plan.runtimeId!, endpointName: PRODUCTION_RUNTIME_ENDPOINT,
        clientToken: undeployClientToken(context.deploymentId, `runtime-endpoint:${resolved.plan.runtimeId}:production`)
      }));
      return 'PENDING' as const;
    } catch (cause) {
      if (isNotFound(cause)) return 'READY' as const;
      throw this.mapError(cause, 'UNDEPLOY_DELETING_ENDPOINT');
    }
  }

  async getProductionEndpointDeletionStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolveUndeploy(context, 'UNDEPLOY_WAITING_ENDPOINT');
    const client = this.createControlClient({ region: resolved.deployment.snapshot.region, credentials: await this.credentials(resolved.connection, resolved.deployment) });
    try {
      const endpoint = await client.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId: resolved.plan.runtimeId!, endpointName: PRODUCTION_RUNTIME_ENDPOINT }));
      return endpoint.status === 'DELETING' ? 'PENDING' as const : 'FAILED' as const;
    } catch (cause) {
      if (isNotFound(cause)) return 'READY' as const;
      throw this.mapError(cause, 'UNDEPLOY_WAITING_ENDPOINT');
    }
  }

  async deleteRuntime(context: DeploymentCommandInput) {
    const resolved = await this.resolveUndeploy(context, 'UNDEPLOY_DELETING_RUNTIME');
    const client = this.createControlClient({ region: resolved.deployment.snapshot.region, credentials: await this.credentials(resolved.connection, resolved.deployment) });
    try {
      await client.send(new DeleteAgentRuntimeCommand({
        agentRuntimeId: resolved.plan.runtimeId!,
        clientToken: undeployClientToken(context.deploymentId, `runtime:${resolved.plan.runtimeId}`)
      }));
      return 'PENDING' as const;
    } catch (cause) {
      if (isNotFound(cause)) return 'READY' as const;
      throw this.mapError(cause, 'UNDEPLOY_DELETING_RUNTIME');
    }
  }

  async getRuntimeDeletionStatus(context: DeploymentCommandInput) {
    const resolved = await this.resolveUndeploy(context, 'UNDEPLOY_WAITING_RUNTIME');
    const client = this.createControlClient({ region: resolved.deployment.snapshot.region, credentials: await this.credentials(resolved.connection, resolved.deployment) });
    try {
      const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: resolved.plan.runtimeId! }));
      return runtime.status === 'DELETING' ? 'PENDING' as const : 'FAILED' as const;
    } catch (cause) {
      if (isNotFound(cause)) return 'READY' as const;
      throw this.mapError(cause, 'UNDEPLOY_WAITING_RUNTIME');
    }
  }

  private async resolve(context: DeploymentCommandInput) {
    const deployment = await this.repository.getDeployment(context.tenantId, context.deploymentId);
    const agent = await this.repository.getAgent(context.tenantId, context.agentId);
    const connection =
      deployment &&
      (await this.repository.getAwsConnection(
        context.tenantId,
        deployment.snapshot.awsConnectionId
      ));
    const artifact =
      deployment?.snapshot.artifactId &&
      (await this.repository.getAgentArtifact(context.tenantId, deployment.snapshot.artifactId));
    if (
      !deployment ||
      !agent ||
      !connection ||
      !artifact ||
      deployment.agentId !== agent.id ||
      connection.status !== 'VERIFIED' ||
      connection.accountId !== deployment.snapshot.accountId ||
      connection.region !== deployment.snapshot.region
    )
      throw new DeploymentError(
        'DEPLOYMENT_SNAPSHOT_INVALID',
        'DEPLOYING_RUNTIME',
        false,
        'The trusted deployment target is unavailable.'
      );
    this.validateArtifact(artifact, deployment);
    return {
      deployment,
      agent,
      connection,
      artifact,
      versions: await this.repository.listRuntimeVersions(context.tenantId, context.agentId)
    };
  }
  private async resolveUndeploy(context: DeploymentCommandInput, stage: DeploymentError['stage']) {
    const deployment = await this.repository.getDeployment(context.tenantId, context.deploymentId);
    const agent = await this.repository.getAgent(context.tenantId, context.agentId);
    const connection = deployment && await this.repository.getAwsConnection(context.tenantId, deployment.snapshot.awsConnectionId);
    const plan = deployment?.cleanupPlan;
    if (!deployment || deployment.operationType !== 'UNDEPLOY' || !agent || agent.status !== 'UNDEPLOYING' || !connection || connection.status !== 'VERIFIED' || !plan?.runtimeId || plan.endpointName !== PRODUCTION_RUNTIME_ENDPOINT || plan.accountId !== deployment.snapshot.accountId || plan.region !== deployment.snapshot.region || connection.accountId !== plan.accountId || connection.region !== plan.region || agent.runtimeId !== plan.runtimeId)
      throw new DeploymentError('RESOURCE_OWNERSHIP_MISMATCH', stage, false, 'Trusted teardown ownership validation failed.');
    return { deployment, agent, connection, plan };
  }
  private async credentials(connection: AwsConnection, deployment: Deployment) {
    return this.assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `runtime-${deployment.id}`
    });
  }
  private artifactRequest(artifact: AgentArtifact): AgentRuntimeArtifact {
    return {
      codeConfiguration: {
        code: {
          s3: {
            bucket: artifact.bucket!,
            prefix: artifact.objectKey!,
            ...(artifact.s3VersionId ? { versionId: artifact.s3VersionId } : {})
          }
        },
        runtime: 'NODE_22',
        entryPoint: artifact.entryPoint
      }
    };
  }
  private environment(deployment: Deployment) {
    if (!deployment.snapshot.gatewayUrl)
      throw new DeploymentError(
        'GATEWAY_NOT_READY',
        'DEPLOYING_RUNTIME',
        false,
        'The trusted Gateway dependency output is unavailable.'
      );
    return {
      AGENT_GATEWAY_URL: deployment.snapshot.gatewayUrl,
      AWS_REGION: deployment.snapshot.region
    };
  }
  private validateArtifact(artifact: AgentArtifact, deployment: Deployment) {
    if (
      artifact.tenantId !== deployment.tenantId ||
      artifact.agentId !== deployment.agentId ||
      artifact.status !== 'READY' ||
      artifact.sha256 !== deployment.snapshot.artifactSha256 ||
      artifact.runtime !== 'NODE_22' ||
      artifact.entryPoint.length !== AGENT_ARTIFACT_ENTRY_POINT.length ||
      artifact.entryPoint.some((value, index) => value !== AGENT_ARTIFACT_ENTRY_POINT[index]) ||
      !artifact.bucket ||
      !artifact.objectKey ||
      artifact.bucket !==
        customerArtifactBucketName(deployment.snapshot.accountId, deployment.snapshot.region)
    )
      throw new DeploymentError(
        'ARTIFACT_INTEGRITY_ERROR',
        'DEPLOYING_RUNTIME',
        false,
        'The immutable deployment artifact is invalid.'
      );
  }
  private desiredCandidate(versions: readonly RuntimeVersion[], deployment: Deployment) {
    return versions.find(
      (v) =>
        v.deploymentId === deployment.id &&
        v.artifactId === deployment.snapshot.artifactId &&
        v.artifactSha256 === deployment.snapshot.artifactSha256 &&
        v.configurationRevision === deployment.configurationRevision
    );
  }
  private requiredCandidate(versions: readonly RuntimeVersion[], deployment: Deployment) {
    const candidate = this.desiredCandidate(versions, deployment);
    if (!candidate)
      throw new DeploymentError(
        'RUNTIME_RECONCILIATION_FAILED',
        'WAITING_FOR_RUNTIME',
        false,
        'No trusted runtime candidate was persisted.'
      );
    return candidate;
  }
  private rollbackTarget(versions: readonly RuntimeVersion[], deployment: Deployment, runtimeId: string | undefined) {
    const target = versions.find((version) => version.runtimeVersion === deployment.targetRuntimeVersion);
    if (!target || !runtimeId || target.runtimeId !== runtimeId || target.state !== 'READY' || !target.productionPromotedAt)
      throw new DeploymentError('ROLLBACK_TARGET_NOT_FOUND', 'ROLLBACK_VERIFYING_TARGET', false, 'Trusted rollback target is unavailable.');
    return target;
  }
  private validateResponse(
    runtimeArn: string,
    workloadIdentityArn: string,
    connection: AwsConnection
  ) {
    try {
      validateRuntimeArn(runtimeArn, connection);
      validateWorkloadIdentityArn(workloadIdentityArn, connection);
    } catch {
      throw new DeploymentError(
        'WORKLOAD_IDENTITY_MISMATCH',
        'DEPLOYING_RUNTIME',
        false,
        'AgentCore returned resources outside the customer target.'
      );
    }
  }
  private mapError(cause: unknown, stage: DeploymentError['stage']): DeploymentError {
    if (cause instanceof DeploymentError) return cause;
    if (cause instanceof AgentCoreSecurityError)
      return new DeploymentError(cause.code, stage, false, 'AgentCore authorization failed.');
    const name = cause instanceof Error ? cause.name : '';
    const retryable = /Throttl|Internal|Timeout|ServiceUnavailable/.test(name);
    const code = /AccessDenied/.test(name)
      ? 'AGENTCORE_ACCESS_DENIED'
      : /ResourceNotFound/.test(name)
        ? 'AGENTCORE_RESOURCE_NOT_FOUND'
        : /ServiceQuota/.test(name)
          ? 'AGENTCORE_SERVICE_QUOTA'
          : /Conflict/.test(name)
            ? 'AGENTCORE_CONFLICT'
            : /Validation/.test(name)
              ? 'AGENTCORE_VALIDATION_ERROR'
              : retryable
                ? 'AGENTCORE_THROTTLED'
                : 'AGENTCORE_OPERATION_FAILED';
    return new DeploymentError(
      code,
      stage,
      retryable,
      'AgentCore operation failed.',
      (cause as { $metadata?: { requestId?: string } })?.$metadata?.requestId
    );
  }
}

function isNotFound(cause: unknown) {
  return cause instanceof Error && /ResourceNotFound|NotFound/.test(cause.name);
}
