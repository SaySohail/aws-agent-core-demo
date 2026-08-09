import {
  AGENT_ARTIFACT_ENTRY_POINT,
  AGENTCORE_RUNTIME,
  AgentArtifactBuilder,
  AgentArtifactError,
  AgentArtifactUploader,
  CUSTOMER_BOOTSTRAP_VERSION,
  customerArtifactBucketName,
  type ControlPlaneRepository,
  type CustomerRoleAssumer
} from '@agent-launchpad/aws';
import {
  bedrockModelCatalog,
  createAgentArtifactId,
  createDeploymentEventId,
  validateAgentDefinitionForDeployment,
  type Deployment,
  type DeploymentStage
} from '@agent-launchpad/schemas';

export class DeploymentError extends Error {
  public constructor(
    readonly code: string,
    readonly stage: DeploymentStage,
    readonly retryable: boolean,
    message: string,
    readonly serviceRequestId?: string
  ) {
    super(message);
  }
}

export interface DeploymentCommandInput {
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly configurationRevision: number;
  readonly artifactId?: string;
}

/** SAY-100 owns the concrete AgentCore Runtime API calls behind these contracts. */
export interface RuntimeDeploymentPort {
  deployRuntime(context: DeploymentCommandInput): Promise<{
    status: 'PENDING' | 'READY' | 'FAILED';
    runtimeArn?: string;
    runtimeVersion?: string;
  }>;
  getRuntimeDeploymentStatus(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
  checkRuntimeHealth(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  promoteProductionEndpoint(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getProductionEndpointStatus(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
  rollbackProductionEndpoint(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getRollbackStatus(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  checkRollbackHealth(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
}

/** Teardown only receives a trusted operation context, never browser-selected AWS identifiers. */
export interface UndeployRuntimePort {
  deleteProductionEndpoint(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getProductionEndpointDeletionStatus(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
  deleteRuntime(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getRuntimeDeletionStatus(
    context: DeploymentCommandInput
  ): Promise<'PENDING' | 'READY' | 'FAILED'>;
}

export interface DependencyProvisioner {
  reconcile(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getStatus(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  compensate(context: DeploymentCommandInput): Promise<void>;
}

export interface UndeployDependencyPort {
  delete(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getDeletionStatus(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
}

export interface ArtifactCleanupPort {
  deleteExactVersions(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  verifyAbsent(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
}

export interface BedrockPreflightChecker {
  check(input: { modelId: string; region: string }): Promise<void>;
}

/** Static catalog check intentionally precedes any customer-account Bedrock control-plane call. */
export class CatalogBedrockPreflightChecker implements BedrockPreflightChecker {
  async check(input: { modelId: string; region: string }): Promise<void> {
    const model = bedrockModelCatalog.find((item) => item.modelId === input.modelId);
    if (!model || model.status !== 'ACTIVE' || !model.supportedRegions.includes(input.region))
      throw new DeploymentError(
        'MODEL_ACCESS_UNAVAILABLE',
        'PREFLIGHT_MODEL',
        false,
        'The selected model is unavailable in the target Region.'
      );
  }
}

export interface DeploymentWorkerDependencies {
  readonly repository: ControlPlaneRepository;
  readonly customerRoleAssumer: CustomerRoleAssumer;
  readonly bedrock: BedrockPreflightChecker;
  readonly dependencies: DependencyProvisioner;
  readonly runtime: RuntimeDeploymentPort;
  readonly artifactPipeline: DeploymentArtifactPipelinePort;
  readonly undeployRuntime?: UndeployRuntimePort;
  readonly undeployDependencies?: UndeployDependencyPort;
  readonly artifactCleanup?: ArtifactCleanupPort;
  readonly now?: () => Date;
}

export interface DeploymentArtifactPipelinePort {
  ensure(deployment: Deployment): Promise<{ artifactId: string; sha256: string }>;
}

/** Creates one immutable package for the deployment's captured configuration, and resumes safely after retries. */
export class DeploymentArtifactPipeline implements DeploymentArtifactPipelinePort {
  public constructor(
    private readonly dependencies: {
      repository: ControlPlaneRepository;
      builder: AgentArtifactBuilder;
      uploader: AgentArtifactUploader;
      now?: () => Date;
    }
  ) {}

  async ensure(deployment: Deployment): Promise<{ artifactId: string; sha256: string }> {
    const [agent, template, connection] = await Promise.all([
      this.dependencies.repository.getAgent(deployment.tenantId, deployment.agentId),
      this.dependencies.repository.getAgentTemplate(
        deployment.snapshot.templateId,
        deployment.snapshot.templateVersion
      ),
      this.dependencies.repository.getAwsConnection(
        deployment.tenantId,
        deployment.snapshot.awsConnectionId
      )
    ]);
    if (!agent || !connection)
      throw new DeploymentError(
        'DEPLOYMENT_SNAPSHOT_INVALID',
        'ENSURING_ARTIFACT',
        false,
        'The captured artifact inputs are unavailable.'
      );
    const snapshotAgent = {
      ...agent,
      templateId: deployment.snapshot.templateId,
      templateVersion: deployment.snapshot.templateVersion,
      revision: deployment.configurationRevision,
      configuration: {
        ...agent.configuration,
        template: {
          id: deployment.snapshot.templateId,
          version: deployment.snapshot.templateVersion
        },
        deploymentTarget: {
          awsConnectionId: deployment.snapshot.awsConnectionId,
          accountId: deployment.snapshot.accountId,
          region: deployment.snapshot.region
        },
        model: { modelId: deployment.snapshot.modelId },
        capabilities: deployment.snapshot.capabilities,
        guardrails: deployment.snapshot.guardrails
      }
    };
    let built;
    try {
      built = await this.dependencies.builder.build({ agent: snapshotAgent, template, connection });
    } catch (cause) {
      throw artifactDeploymentError(cause, 'BUILDING');
    }
    let artifact = await this.dependencies.repository.findAgentArtifactByDigest(
      deployment.tenantId,
      deployment.agentId,
      built.sha256
    );
    const now = () => (this.dependencies.now?.() ?? new Date()).toISOString();
    if (!artifact) {
      const candidate = {
        id: createAgentArtifactId(),
        tenantId: deployment.tenantId,
        agentId: deployment.agentId,
        templateId: deployment.snapshot.templateId,
        templateVersion: deployment.snapshot.templateVersion,
        configurationVersion: deployment.configurationRevision,
        runtime: AGENTCORE_RUNTIME,
        entryPoint: [...AGENT_ARTIFACT_ENTRY_POINT] as ['opentelemetry-instrument', 'dist/app.js'],
        sha256: built.sha256,
        sizeBytes: built.sizeBytes,
        status: 'BUILDING' as const,
        createdBy: deployment.requestedBy,
        createdAt: now(),
        updatedAt: now()
      };
      try {
        await this.dependencies.repository.createAgentArtifact(candidate);
        artifact = candidate;
      } catch (cause) {
        artifact = await this.dependencies.repository.findAgentArtifactByDigest(
          deployment.tenantId,
          deployment.agentId,
          built.sha256
        );
        if (!artifact) throw cause;
      }
    }
    if (artifact.status !== 'READY') {
      await this.dependencies.repository.updateAgentArtifact(deployment.tenantId, artifact.id, {
        status: 'UPLOADING',
        updatedAt: now(),
        errorCode: undefined
      });
      let uploaded;
      try {
        uploaded = await this.dependencies.uploader.upload({
          tenantId: deployment.tenantId,
          agentId: deployment.agentId,
          sha256: built.sha256,
          configurationVersion: deployment.configurationRevision,
          templateVersion: deployment.snapshot.templateVersion,
          bytes: built.bytes,
          connection
        });
      } catch (cause) {
        await this.dependencies.repository
          .updateAgentArtifact(deployment.tenantId, artifact.id, {
            status: 'FAILED',
            updatedAt: now(),
            errorCode: cause instanceof AgentArtifactError ? cause.code : 'ARTIFACT_UPLOAD_FAILED'
          })
          .catch(() => undefined);
        throw artifactDeploymentError(cause, 'UPLOADING');
      }
      // If this write fails after S3 accepted the object, the next retry HEADs the same content-addressed
      // key, validates KMS/version metadata, and completes this record without creating another package.
      await this.dependencies.repository.updateAgentArtifact(deployment.tenantId, artifact.id, {
        status: 'READY',
        bucket: uploaded.bucket,
        objectKey: uploaded.key,
        s3VersionId: uploaded.versionId,
        updatedAt: now(),
        errorCode: undefined
      });
      artifact = { ...artifact, status: 'READY', sha256: built.sha256 };
    }
    await this.dependencies.repository.attachDeploymentArtifact(
      deployment.tenantId,
      deployment.id,
      artifact.id,
      built.sha256
    );
    return { artifactId: artifact.id, sha256: built.sha256 };
  }
}

function artifactDeploymentError(
  cause: unknown,
  status: 'BUILDING' | 'UPLOADING'
): DeploymentError {
  return new DeploymentError(
    cause instanceof AgentArtifactError ? cause.code : 'ARTIFACT_BUILD_FAILED',
    'ENSURING_ARTIFACT',
    false,
    `Artifact ${status.toLowerCase()} failed.`
  );
}

export class DeploymentWorker {
  public constructor(private readonly dependencies: DeploymentWorkerDependencies) {}

  async dispatch(
    stage: DeploymentStage,
    input: DeploymentCommandInput
  ): Promise<{ status: 'PENDING' | 'READY' | 'FAILED' }> {
    const deployment = await this.deployment(input);
    await this.persistStage(deployment, stage);
    try {
      const result =
        deployment.operationType === 'ROLLBACK'
          ? await this.rollback(stage, input)
          : deployment.operationType === 'UNDEPLOY'
            ? await this.undeploy(stage, input)
            : await this.deploy(stage, input, deployment);
      if (this.isTerminalSuccess(stage, result.status))
        await this.persistTerminal(
          deployment,
          deployment.operationType === 'UNDEPLOY' ? 'UNDEPLOYED' : 'READY'
        );
      return result;
    } catch (cause) {
      const error =
        cause instanceof DeploymentError
          ? cause
          : new DeploymentError(
              'DEPLOYMENT_WORKER_FAILED',
              stage,
              false,
              'Deployment worker failed.'
            );
      if (!error.retryable) await this.persistFailure(deployment, error);
      throw error;
    }
  }

  private async deploy(
    stage: DeploymentStage,
    input: DeploymentCommandInput,
    deployment: Deployment
  ): Promise<{ status: 'PENDING' | 'READY' | 'FAILED' }> {
    switch (stage) {
      case 'VALIDATING':
        return this.validate(deployment);
      case 'VERIFYING_CUSTOMER_ACCESS':
        return this.verifyCustomerAccess(deployment);
      case 'PREFLIGHT_REGION':
        return this.preflightRegion(deployment);
      case 'PREFLIGHT_MODEL':
        await this.dependencies.bedrock.check({
          modelId: deployment.snapshot.modelId,
          region: deployment.snapshot.region
        });
        return { status: 'READY' };
      case 'PREFLIGHT_IAM':
        return this.preflightIam(deployment);
      case 'PREFLIGHT_STORAGE':
        return this.preflightStorage(deployment);
      case 'PREFLIGHT_AGENTCORE':
        return { status: 'READY' };
      case 'ENSURING_ARTIFACT':
        return this.ensureArtifact(deployment);
      case 'PROVISIONING_DEPENDENCIES':
        return { status: await this.dependencies.dependencies.reconcile(input) };
      case 'WAITING_FOR_DEPENDENCIES':
        return { status: await this.dependencies.dependencies.getStatus(input) };
      case 'DEPLOYING_RUNTIME':
        return this.dependencies.runtime.deployRuntime(input);
      case 'WAITING_FOR_RUNTIME':
        return {
          status: (await this.dependencies.runtime.getRuntimeDeploymentStatus(input)) as
            | 'PENDING'
            | 'READY'
            | 'FAILED'
        };
      case 'HEALTH_CHECKING':
        return {
          status: (await this.dependencies.runtime.checkRuntimeHealth(input)) as
            | 'PENDING'
            | 'READY'
            | 'FAILED'
        };
      case 'PROMOTING_ENDPOINT':
        return { status: await this.dependencies.runtime.promoteProductionEndpoint(input) };
      case 'WAITING_FOR_ENDPOINT':
        return { status: await this.dependencies.runtime.getProductionEndpointStatus(input) };
      case 'READY':
      case 'FAILED':
      case 'QUEUED':
      case 'ROLLBACK_VALIDATING':
      case 'ROLLBACK_VERIFYING_TARGET':
      case 'ROLLBACK_UPDATING_ENDPOINT':
      case 'ROLLBACK_WAITING_FOR_ENDPOINT':
      case 'ROLLBACK_HEALTH_CHECKING':
      case 'ROLLBACK_REVERTING_ENDPOINT':
      case 'UNDEPLOY_QUEUED':
      case 'UNDEPLOY_VALIDATING':
      case 'UNDEPLOY_DISABLING_INVOCATION':
      case 'UNDEPLOY_DELETING_ENDPOINT':
      case 'UNDEPLOY_WAITING_ENDPOINT':
      case 'UNDEPLOY_DELETING_RUNTIME':
      case 'UNDEPLOY_WAITING_RUNTIME':
      case 'UNDEPLOY_DELETING_DEPENDENCIES':
      case 'UNDEPLOY_WAITING_DEPENDENCIES':
      case 'UNDEPLOY_DELETING_ARTIFACTS':
      case 'UNDEPLOY_VERIFYING':
      case 'UNDEPLOYED':
        throw new DeploymentError(
          'INVALID_STAGE',
          stage,
          false,
          'Terminal stages are not worker commands.'
        );
    }
  }

  private async undeploy(
    stage: DeploymentStage,
    input: DeploymentCommandInput
  ): Promise<{ status: 'PENDING' | 'READY' | 'FAILED' }> {
    const runtime = this.dependencies.undeployRuntime;
    if (!runtime)
      throw new DeploymentError(
        'UNDEPLOY_NOT_CONFIGURED',
        stage,
        false,
        'Teardown processing is not configured.'
      );
    switch (stage) {
      case 'UNDEPLOY_VALIDATING':
      case 'UNDEPLOY_DISABLING_INVOCATION':
        return { status: 'READY' as const };
      case 'UNDEPLOY_DELETING_ENDPOINT':
        return this.cleanupResult(
          input,
          'RUNTIME_ENDPOINT',
          await runtime.deleteProductionEndpoint(input)
        );
      case 'UNDEPLOY_WAITING_ENDPOINT':
        return this.cleanupResult(
          input,
          'RUNTIME_ENDPOINT',
          await runtime.getProductionEndpointDeletionStatus(input)
        );
      case 'UNDEPLOY_DELETING_RUNTIME':
        return this.cleanupResult(input, 'RUNTIME', await runtime.deleteRuntime(input));
      case 'UNDEPLOY_WAITING_RUNTIME':
        return this.cleanupResult(input, 'RUNTIME', await runtime.getRuntimeDeletionStatus(input));
      case 'UNDEPLOY_DELETING_DEPENDENCIES':
        return this.cleanupResult(
          input,
          'DEPENDENCY_STACK',
          await this.requireUndeployDependencies(stage).delete(input)
        );
      case 'UNDEPLOY_WAITING_DEPENDENCIES':
        return this.cleanupResult(
          input,
          'DEPENDENCY_STACK',
          await this.requireUndeployDependencies(stage).getDeletionStatus(input)
        );
      case 'UNDEPLOY_DELETING_ARTIFACTS':
        return this.cleanupResult(
          input,
          'ARTIFACT',
          await this.requireArtifactCleanup(stage).deleteExactVersions(input)
        );
      case 'UNDEPLOY_VERIFYING':
        return { status: await this.requireArtifactCleanup(stage).verifyAbsent(input) };
      default:
        throw new DeploymentError(
          'INVALID_STAGE',
          stage,
          false,
          'Terminal stages are not worker commands.'
        );
    }
  }

  private async rollback(stage: DeploymentStage, input: DeploymentCommandInput) {
    switch (stage) {
      case 'DEPLOYING_RUNTIME':
        return { status: await this.dependencies.runtime.rollbackProductionEndpoint(input) };
      case 'WAITING_FOR_RUNTIME':
        return { status: await this.dependencies.runtime.getRollbackStatus(input) };
      case 'HEALTH_CHECKING':
        return { status: await this.dependencies.runtime.checkRollbackHealth(input) };
      case 'VALIDATING':
      case 'VERIFYING_CUSTOMER_ACCESS':
      case 'PREFLIGHT_REGION':
      case 'PREFLIGHT_MODEL':
      case 'PREFLIGHT_IAM':
      case 'PREFLIGHT_STORAGE':
      case 'PREFLIGHT_AGENTCORE':
      case 'ENSURING_ARTIFACT':
      case 'PROVISIONING_DEPENDENCIES':
      case 'WAITING_FOR_DEPENDENCIES':
      case 'PROMOTING_ENDPOINT':
      case 'WAITING_FOR_ENDPOINT':
        return { status: 'READY' as const };
      default:
        throw new DeploymentError(
          'INVALID_STAGE',
          stage,
          false,
          'Terminal stages are not worker commands.'
        );
    }
  }

  private async deployment(input: DeploymentCommandInput): Promise<Deployment> {
    const deployment = await this.dependencies.repository.getDeployment(
      input.tenantId,
      input.deploymentId
    );
    if (
      !deployment ||
      deployment.agentId !== input.agentId ||
      deployment.configurationRevision !== input.configurationRevision
    )
      throw new DeploymentError(
        'DEPLOYMENT_SNAPSHOT_INVALID',
        'VALIDATING',
        false,
        'Deployment snapshot is unavailable.'
      );
    return deployment;
  }
  private async validate(deployment: Deployment) {
    const [agent, template, connection] = await Promise.all([
      this.dependencies.repository.getAgent(deployment.tenantId, deployment.agentId),
      this.dependencies.repository.getAgentTemplate(
        deployment.snapshot.templateId,
        deployment.snapshot.templateVersion
      ),
      this.dependencies.repository.getAwsConnection(
        deployment.tenantId,
        deployment.snapshot.awsConnectionId
      )
    ]);
    if (
      !agent ||
      agent.tenantId !== deployment.tenantId ||
      agent.revision < deployment.configurationRevision ||
      !connection ||
      connection.accountId !== deployment.snapshot.accountId
    )
      throw new DeploymentError(
        'DEPLOYMENT_SNAPSHOT_INVALID',
        'VALIDATING',
        false,
        'Deployment snapshot validation failed.'
      );
    const snapshotAgent = {
      ...agent,
      templateId: deployment.snapshot.templateId,
      templateVersion: deployment.snapshot.templateVersion,
      revision: deployment.configurationRevision,
      configuration: {
        ...agent.configuration,
        template: {
          id: deployment.snapshot.templateId,
          version: deployment.snapshot.templateVersion
        },
        deploymentTarget: {
          awsConnectionId: deployment.snapshot.awsConnectionId,
          accountId: deployment.snapshot.accountId,
          region: deployment.snapshot.region
        },
        model: { modelId: deployment.snapshot.modelId },
        capabilities: deployment.snapshot.capabilities,
        guardrails: deployment.snapshot.guardrails
      }
    };
    if (validateAgentDefinitionForDeployment(snapshotAgent, template, connection).length)
      throw new DeploymentError(
        'DEPLOYMENT_SNAPSHOT_INVALID',
        'VALIDATING',
        false,
        'Deployment configuration is not ready.'
      );
    return { status: 'READY' as const };
  }
  private async verifyCustomerAccess(deployment: Deployment) {
    const connection = await this.dependencies.repository.getAwsConnection(
      deployment.tenantId,
      deployment.snapshot.awsConnectionId
    );
    if (!connection || connection.status !== 'VERIFIED')
      throw new DeploymentError(
        'CUSTOMER_ACCESS_REVOKED',
        'VERIFYING_CUSTOMER_ACCESS',
        false,
        'Customer AWS access is not verified.'
      );
    const credentials = await this.dependencies.customerRoleAssumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `deploy-${deployment.id}`
    });
    const identity = await this.dependencies.customerRoleAssumer.getCallerIdentity(credentials);
    if (identity.account !== deployment.snapshot.accountId)
      throw new DeploymentError(
        'CUSTOMER_ACCOUNT_MISMATCH',
        'VERIFYING_CUSTOMER_ACCESS',
        false,
        'Customer AWS account did not match the deployment target.'
      );
    return { status: 'READY' as const };
  }
  private async preflightRegion(deployment: Deployment) {
    if (
      !bedrockModelCatalog.some((item) =>
        item.supportedRegions.includes(deployment.snapshot.region)
      )
    )
      throw new DeploymentError(
        'UNSUPPORTED_REGION',
        'PREFLIGHT_REGION',
        false,
        'The target Region is not supported.'
      );
    return { status: 'READY' as const };
  }
  private async preflightIam(deployment: Deployment) {
    const connection = await this.dependencies.repository.getAwsConnection(
      deployment.tenantId,
      deployment.snapshot.awsConnectionId
    );
    if (!connection || connection.bootstrapVersion !== CUSTOMER_BOOTSTRAP_VERSION)
      throw new DeploymentError(
        'BOOTSTRAP_INCOMPATIBLE',
        'PREFLIGHT_IAM',
        false,
        'Customer bootstrap is not compatible.'
      );
    return { status: 'READY' as const };
  }
  private async preflightStorage(deployment: Deployment) {
    if (!deployment.snapshot.artifactId || !deployment.snapshot.artifactSha256)
      return { status: 'READY' as const };
    const artifact = await this.dependencies.repository.getAgentArtifact(
      deployment.tenantId,
      deployment.snapshot.artifactId
    );
    if (
      !artifact ||
      artifact.status !== 'READY' ||
      artifact.sha256 !== deployment.snapshot.artifactSha256 ||
      artifact.bucket !==
        customerArtifactBucketName(deployment.snapshot.accountId, deployment.snapshot.region)
    )
      throw new DeploymentError(
        'ARTIFACT_INTEGRITY_ERROR',
        'PREFLIGHT_STORAGE',
        false,
        'The immutable artifact is unavailable or invalid.'
      );
    return { status: 'READY' as const };
  }
  private async ensureArtifact(deployment: Deployment) {
    await this.dependencies.artifactPipeline.ensure(deployment);
    const resolved = await this.deployment({
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      agentId: deployment.agentId,
      configurationRevision: deployment.configurationRevision
    });
    return this.preflightStorage(resolved);
  }
  private requireUndeployDependencies(stage: DeploymentStage): UndeployDependencyPort {
    if (this.dependencies.undeployDependencies) return this.dependencies.undeployDependencies;
    throw new DeploymentError(
      'UNDEPLOY_NOT_CONFIGURED',
      stage,
      false,
      'Dependency teardown is not configured.'
    );
  }
  private requireArtifactCleanup(stage: DeploymentStage): ArtifactCleanupPort {
    if (this.dependencies.artifactCleanup) return this.dependencies.artifactCleanup;
    throw new DeploymentError(
      'UNDEPLOY_NOT_CONFIGURED',
      stage,
      false,
      'Artifact cleanup is not configured.'
    );
  }
  private async persistStage(deployment: Deployment, stage: DeploymentStage) {
    if (deployment.stage === stage) return;
    const now = (this.dependencies.now?.() ?? new Date()).toISOString();
    await this.dependencies.repository.recordDeploymentStage({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      fromStage: deployment.stage,
      toStage: stage,
      status: 'IN_PROGRESS',
      updatedAt: now,
      event: {
        id: createDeploymentEventId(),
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        fromStage: deployment.stage,
        toStage: stage,
        status: 'IN_PROGRESS',
        createdAt: now
      }
    });
  }
  private async persistTerminal(deployment: Deployment, terminal: 'READY' | 'UNDEPLOYED') {
    const current = await this.deployment({
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      agentId: deployment.agentId,
      configurationRevision: deployment.configurationRevision
    });
    if (current.stage === terminal) return;
    const now = (this.dependencies.now?.() ?? new Date()).toISOString();
    await this.dependencies.repository.recordDeploymentStage({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      fromStage: current.stage,
      toStage: terminal,
      status: 'READY',
      updatedAt: now,
      completedAt: now,
      event: {
        id: createDeploymentEventId(),
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        fromStage: current.stage,
        toStage: terminal,
        status: 'READY',
        createdAt: now
      }
    });
    if (terminal === 'UNDEPLOYED')
      await this.dependencies.repository.completeAgentUndeploy(
        deployment.tenantId,
        deployment.agentId,
        now
      );
  }
  private async persistFailure(deployment: Deployment, error: DeploymentError) {
    const current = await this.deployment({
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      agentId: deployment.agentId,
      configurationRevision: deployment.configurationRevision
    });
    if (current.stage === 'FAILED') return;
    const now = (this.dependencies.now?.() ?? new Date()).toISOString();
    await this.dependencies.repository.recordDeploymentStage({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      fromStage: current.stage,
      toStage: 'FAILED',
      status: 'FAILED',
      updatedAt: now,
      completedAt: now,
      errorCode: error.code,
      errorMessage: error.message,
      event: {
        id: createDeploymentEventId(),
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        fromStage: current.stage,
        toStage: 'FAILED',
        status: 'FAILED',
        errorCode: error.code,
        createdAt: now
      }
    });
  }
  private isTerminalSuccess(stage: DeploymentStage, status: 'PENDING' | 'READY' | 'FAILED') {
    return (
      status === 'READY' && (stage === 'WAITING_FOR_ENDPOINT' || stage === 'UNDEPLOY_VERIFYING')
    );
  }
  private async cleanupResult(
    input: DeploymentCommandInput,
    kind: 'RUNTIME_ENDPOINT' | 'RUNTIME' | 'DEPENDENCY_STACK' | 'ARTIFACT',
    status: 'PENDING' | 'READY' | 'FAILED'
  ) {
    const deployment = await this.deployment(input);
    const now = (this.dependencies.now?.() ?? new Date()).toISOString();
    const next = (deployment.cleanupLedger ?? []).map((entry) =>
      entry.kind !== kind || entry.status === 'DELETED' || entry.status === 'SKIPPED'
        ? entry
        : {
            ...entry,
            status:
              status === 'READY'
                ? ('DELETED' as const)
                : status === 'FAILED'
                  ? ('FAILED' as const)
                  : ('DELETING' as const),
            updatedAt: now,
            ...(status === 'READY' ? { deletedAt: now, errorCode: undefined } : {})
          }
    );
    if (next.length)
      await this.dependencies.repository.updateDeploymentCleanupLedger(
        input.tenantId,
        input.deploymentId,
        next
      );
    return { status };
  }
}

/** Retained entry point for Lambda bundling; infrastructure injects the concrete adapter. */
export function createDeploymentWorkerBoundary(environment: Record<string, string | undefined>) {
  return {
    environment,
    acceptsCredentialsInInput: false,
    runtimeImplementation: 'SAY-100-port-only'
  };
}
