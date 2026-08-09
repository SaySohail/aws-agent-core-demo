import {
  CUSTOMER_BOOTSTRAP_VERSION,
  customerArtifactBucketName,
  type ControlPlaneRepository,
  type CustomerRoleAssumer
} from '@agent-launchpad/aws';
import {
  bedrockModelCatalog,
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
}

export interface DependencyProvisioner {
  reconcile(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  getStatus(context: DeploymentCommandInput): Promise<'PENDING' | 'READY' | 'FAILED'>;
  compensate(context: DeploymentCommandInput): Promise<void>;
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
  readonly now?: () => Date;
}

export class DeploymentWorker {
  public constructor(private readonly dependencies: DeploymentWorkerDependencies) {}

  async dispatch(
    stage: DeploymentStage,
    input: DeploymentCommandInput
  ): Promise<{ status: 'PENDING' | 'READY' | 'FAILED' }> {
    const deployment = await this.deployment(input);
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
    if (!deployment.snapshot.artifactId)
      throw new DeploymentError(
        'ARTIFACT_NOT_READY',
        'ENSURING_ARTIFACT',
        false,
        'No immutable artifact is available for this deployment.'
      );
    return this.preflightStorage(deployment);
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
