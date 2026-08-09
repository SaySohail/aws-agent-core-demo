import {
  agentSchema,
  type AgentArtifact,
  type Agent,
  type AgentTemplate,
  type AuditEvent,
  type AwsConnection,
  type Deployment,
  type DeploymentEvent,
  type RuntimeVersion,
  type Tenant,
  type TenantContext,
  type TenantMembership
} from '@agent-launchpad/schemas';
import { controlPlaneKeys, sortKeyPrefixes } from './keys.js';
import { fromPersistence, toPersistence } from './mappers.js';
import { decodePageToken, encodePageToken, page, type Page } from './pagination.js';
import type { PersistenceClient } from './store.js';

export interface ListOptions {
  readonly limit?: number;
  readonly nextToken?: string;
}

const createCondition = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';
const existingCondition = 'attribute_exists(pk) AND attribute_exists(sk)';
const verifyingCondition =
  'attribute_exists(pk) AND attribute_exists(sk) AND #connectionStatus IN (:pending, :failed, :verified)';
const finishVerificationCondition =
  'attribute_exists(pk) AND attribute_exists(sk) AND #connectionStatus = :verifying';

/** Server-only boundary. Every tenant-owned lookup starts with the caller's tenant partition. */
export class ControlPlaneRepository {
  public constructor(private readonly store: PersistenceClient) {}

  async createTenant(tenant: Tenant): Promise<void> {
    await this.store.put(toPersistence.tenant(tenant), createCondition);
  }
  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    return this.get(controlPlaneKeys.tenant(tenantId), fromPersistence.tenant);
  }

  async listTenantsForUser(userId: string, options: ListOptions = {}): Promise<Page<Tenant>> {
    const result = await this.list(
      'MembershipsByUser',
      'gsi1pk',
      controlPlaneKeys.userMemberships(userId).gsi1pk,
      undefined,
      options,
      fromPersistence.membership
    );
    const items = await this.store.batchGet(
      result.items.map((membership) => controlPlaneKeys.tenant(membership.tenantId))
    );
    return page(items.map(fromPersistence.tenant), result.nextToken);
  }

  async createMembership(membership: TenantMembership): Promise<void> {
    await this.store.put(toPersistence.membership(membership), createCondition);
  }
  async getMembership(tenantId: string, userId: string): Promise<TenantMembership | undefined> {
    return this.get(controlPlaneKeys.membership(tenantId, userId), fromPersistence.membership);
  }
  async listMembers(tenantId: string, options: ListOptions = {}): Promise<Page<TenantMembership>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.members,
      options,
      fromPersistence.membership
    );
  }

  async resolveTenantContext(userId: string, tenantId: string): Promise<TenantContext | undefined> {
    const membership = await this.getMembership(tenantId, userId);
    const tenant = membership ? await this.getTenant(tenantId) : undefined;
    return membership && tenant?.status === 'ACTIVE'
      ? { userId, tenantId, role: membership.role }
      : undefined;
  }

  async listTenantContexts(
    userId: string,
    options: ListOptions = {}
  ): Promise<Page<TenantContext>> {
    const memberships = await this.listTenantsForUser(userId, options);
    const items: TenantContext[] = [];
    for (const tenant of memberships.items) {
      const context = await this.resolveTenantContext(userId, tenant.id);
      if (context) items.push(context);
    }
    return page(items, memberships.nextToken);
  }

  async createAwsConnection(value: AwsConnection): Promise<void> {
    await this.store.put(toPersistence.awsConnection(value), createCondition);
  }
  async getAwsConnection(tenantId: string, id: string): Promise<AwsConnection | undefined> {
    return this.get(controlPlaneKeys.awsConnection(tenantId, id), fromPersistence.awsConnection);
  }
  async listAwsConnections(
    tenantId: string,
    options: ListOptions = {}
  ): Promise<Page<AwsConnection>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.awsConnections,
      options,
      fromPersistence.awsConnection
    );
  }
  async startAwsConnectionVerification(
    tenantId: string,
    id: string,
    updatedAt: string
  ): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.awsConnection(tenantId, id),
      updates: { status: 'VERIFYING', updatedAt },
      condition: verifyingCondition,
      conditionNames: { '#connectionStatus': 'status' },
      conditionValues: { ':pending': 'PENDING', ':failed': 'FAILED', ':verified': 'VERIFIED' }
    });
  }
  async completeAwsConnectionVerification(
    tenantId: string,
    id: string,
    changes: Pick<AwsConnection, 'status' | 'updatedAt'> & Partial<AwsConnection>
  ): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.awsConnection(tenantId, id),
      updates: awsConnectionChanges(changes),
      condition: finishVerificationCondition,
      conditionNames: { '#connectionStatus': 'status' },
      conditionValues: { ':verifying': 'VERIFYING' }
    });
  }

  async createAgent(value: Agent): Promise<void> {
    await this.store.put(toPersistence.agent(value), createCondition);
  }
  async getAgent(tenantId: string, id: string): Promise<Agent | undefined> {
    return this.get(controlPlaneKeys.agent(tenantId, id), fromPersistence.agent);
  }
  async listAgents(tenantId: string, options: ListOptions = {}): Promise<Page<Agent>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.agents,
      options,
      fromPersistence.agent
    );
  }
  async createAgentArtifact(value: AgentArtifact): Promise<void> {
    if (!(await this.getAgent(value.tenantId, value.agentId)))
      throw new Error('Cannot create an artifact for a missing tenant agent.');
    await this.store.put(toPersistence.agentArtifact(value), createCondition);
  }
  async getAgentArtifact(tenantId: string, id: string): Promise<AgentArtifact | undefined> {
    return this.get(controlPlaneKeys.artifact(tenantId, id), fromPersistence.agentArtifact);
  }
  async listAgentArtifacts(
    tenantId: string,
    options: ListOptions = {}
  ): Promise<Page<AgentArtifact>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.artifacts,
      options,
      fromPersistence.agentArtifact
    );
  }
  async updateAgentArtifact(
    tenantId: string,
    id: string,
    changes: Pick<AgentArtifact, 'status' | 'updatedAt'> &
      Partial<Pick<AgentArtifact, 'bucket' | 'objectKey' | 's3VersionId' | 'errorCode'>>
  ): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.artifact(tenantId, id),
      updates: changes,
      condition: existingCondition
    });
  }
  async createRuntimeVersion(value: RuntimeVersion): Promise<void> {
    if (!(await this.getAgent(value.tenantId, value.agentId)))
      throw new Error('Cannot create a runtime version for a missing tenant agent.');
    await this.store.put(toPersistence.runtimeVersion(value), createCondition);
  }
  async getRuntimeVersion(tenantId: string, id: string): Promise<RuntimeVersion | undefined> {
    return this.get(controlPlaneKeys.runtimeVersion(tenantId, id), fromPersistence.runtimeVersion);
  }
  async listRuntimeVersions(tenantId: string, agentId: string): Promise<readonly RuntimeVersion[]> {
    const result = await this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.runtimeVersions,
      {},
      fromPersistence.runtimeVersion
    );
    return result.items.filter((item) => item.agentId === agentId);
  }
  /** Mutable operational status only; immutable identity/artifact fields cannot be replaced. */
  async updateRuntimeVersionStatus(
    tenantId: string,
    id: string,
    changes: Pick<RuntimeVersion, 'state' | 'updatedAt'> &
      Partial<
        Pick<
          RuntimeVersion,
          'endpointName' | 'endpointArn' | 'endpointTargetVersion' | 'endpointLiveVersion'
        >
      >
  ): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.runtimeVersion(tenantId, id),
      updates: changes,
      condition: existingCondition
    });
  }
  async promoteAgentRuntime(input: {
    tenantId: string;
    agentId: string;
    runtimeId: string;
    runtimeArn: string;
    runtimeVersion: string;
    runtimeEndpoint: string;
    runtimeEndpointName: string;
    runtimeWorkloadIdentityArn: string;
    updatedAt: string;
  }): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.agent(input.tenantId, input.agentId),
      updates: input,
      condition: existingCondition
    });
  }
  async updateAgent(
    context: TenantContext,
    agentId: string,
    changes: Pick<
      Agent,
      | 'templateId'
      | 'templateVersion'
      | 'name'
      | 'model'
      | 'region'
      | 'configuration'
      | 'revision'
      | 'updatedAt'
    >,
    expectedRevision: number
  ): Promise<void> {
    const parsed = agentSchema
      .pick({
        name: true,
        templateId: true,
        templateVersion: true,
        model: true,
        region: true,
        configuration: true,
        revision: true,
        updatedAt: true
      })
      .parse(changes);
    await this.store.update({
      key: controlPlaneKeys.agent(context.tenantId, agentId),
      updates: parsed,
      condition: 'attribute_exists(pk) AND attribute_exists(sk) AND #revision = :expectedRevision',
      conditionNames: { '#revision': 'revision' },
      conditionValues: { ':expectedRevision': expectedRevision }
    });
  }
  async deleteAgent(context: TenantContext, agentId: string): Promise<void> {
    await this.store.delete(controlPlaneKeys.agent(context.tenantId, agentId), existingCondition);
  }

  async createDeployment(value: Deployment): Promise<void> {
    if (!(await this.getAgent(value.tenantId, value.agentId)))
      throw new Error('Cannot create a deployment for a missing tenant agent.');
    await this.store.put(toPersistence.deployment(value), createCondition);
  }
  /**
   * Conditional server-side request identity. The API reads this record before attempting a new
   * deployment, so retries recover the original deployment without exposing workflow internals.
   */
  async getDeploymentByIdempotency(
    tenantId: string,
    agentId: string,
    idempotencyKeyHash: string
  ): Promise<{ deploymentId: string; requestHash: string } | undefined> {
    const item = await this.store.get(
      controlPlaneKeys.deploymentIdempotency(tenantId, agentId, idempotencyKeyHash)
    );
    if (!item || typeof item.deploymentId !== 'string' || typeof item.requestHash !== 'string')
      return undefined;
    return { deploymentId: item.deploymentId, requestHash: item.requestHash };
  }
  async createDeploymentIdempotency(value: {
    tenantId: string;
    agentId: string;
    idempotencyKeyHash: string;
    requestHash: string;
    deploymentId: string;
    createdAt: string;
  }): Promise<void> {
    await this.store.put(
      {
        ...controlPlaneKeys.deploymentIdempotency(
          value.tenantId,
          value.agentId,
          value.idempotencyKeyHash
        ),
        ...value
      },
      createCondition
    );
  }
  async acquireDeploymentLock(value: {
    tenantId: string;
    agentId: string;
    deploymentId: string;
    configurationRevision: number;
    acquiredAt: string;
  }): Promise<void> {
    await this.store.put(
      { ...controlPlaneKeys.deploymentLock(value.tenantId, value.agentId), ...value },
      createCondition
    );
  }
  async getDeploymentLock(
    tenantId: string,
    agentId: string
  ): Promise<{ deploymentId: string } | undefined> {
    const item = await this.store.get(controlPlaneKeys.deploymentLock(tenantId, agentId));
    return item && typeof item.deploymentId === 'string'
      ? { deploymentId: item.deploymentId }
      : undefined;
  }
  async releaseDeploymentLock(
    tenantId: string,
    agentId: string,
    deploymentId: string
  ): Promise<void> {
    await this.store.delete(
      controlPlaneKeys.deploymentLock(tenantId, agentId),
      'attribute_exists(pk) AND attribute_exists(sk) AND deploymentId = :deploymentId',
      { ':deploymentId': deploymentId }
    );
  }
  async setDeploymentExecutionArn(
    tenantId: string,
    id: string,
    executionArn: string
  ): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.deployment(tenantId, id),
      updates: { executionArn },
      condition: existingCondition
    });
  }
  async appendDeploymentEvent(value: DeploymentEvent): Promise<void> {
    await this.store.put(toPersistence.deploymentEvent(value), createCondition);
  }
  async listDeploymentEvents(
    tenantId: string,
    deploymentId: string,
    options: ListOptions = {}
  ): Promise<Page<DeploymentEvent>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      `DEPLOYMENT_EVENT#${deploymentId}#`,
      options,
      fromPersistence.deploymentEvent
    );
  }
  async transitionDeployment(input: {
    tenantId: string;
    deploymentId: string;
    fromStage: Deployment['stage'];
    toStage: Deployment['stage'];
    status: Deployment['status'];
    updatedAt: string;
    errorCode?: string;
    errorMessage?: string;
    completedAt?: string;
  }): Promise<void> {
    await this.store.update({
      key: controlPlaneKeys.deployment(input.tenantId, input.deploymentId),
      updates: {
        stage: input.toStage,
        status: input.status,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        ...(input.completedAt ? { completedAt: input.completedAt } : {})
      },
      condition: 'attribute_exists(pk) AND attribute_exists(sk) AND #stage = :fromStage',
      conditionNames: { '#stage': 'stage' },
      conditionValues: { ':fromStage': input.fromStage }
    });
  }
  async getDeployment(tenantId: string, id: string): Promise<Deployment | undefined> {
    return this.get(controlPlaneKeys.deployment(tenantId, id), fromPersistence.deployment);
  }
  async listDeployments(tenantId: string, options: ListOptions = {}): Promise<Page<Deployment>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.deployments,
      options,
      fromPersistence.deployment
    );
  }
  async listDeploymentsForAgent(
    tenantId: string,
    agentId: string,
    options: ListOptions = {}
  ): Promise<Page<Deployment>> {
    return this.list(
      'DeploymentsByAgent',
      'gsi2pk',
      controlPlaneKeys.agentDeployments(tenantId, agentId).gsi2pk,
      undefined,
      options,
      fromPersistence.deployment
    );
  }

  /** Append-only by design: this boundary intentionally offers neither update nor delete audit methods. */
  async appendAuditEvent(value: AuditEvent): Promise<void> {
    await this.store.put(toPersistence.auditEvent(value), createCondition);
  }
  async listAuditEvents(tenantId: string, options: ListOptions = {}): Promise<Page<AuditEvent>> {
    return this.list(
      undefined,
      'pk',
      controlPlaneKeys.tenant(tenantId).pk,
      sortKeyPrefixes.audits,
      options,
      fromPersistence.auditEvent
    );
  }

  async createAgentTemplate(value: AgentTemplate): Promise<void> {
    await this.store.put(toPersistence.agentTemplate(value), createCondition);
  }
  async getAgentTemplate(templateId: string, version: string): Promise<AgentTemplate | undefined> {
    return this.get(controlPlaneKeys.template(templateId, version), fromPersistence.agentTemplate);
  }
  async listAgentTemplates(options: ListOptions = {}): Promise<Page<AgentTemplate>> {
    return this.list(
      'MembershipsByUser',
      'gsi1pk',
      controlPlaneKeys.globalTemplates().gsi1pk,
      undefined,
      options,
      fromPersistence.agentTemplate
    );
  }

  private async get<T>(
    key: Record<string, string>,
    mapper: (item: Record<string, unknown>) => T
  ): Promise<T | undefined> {
    const item = await this.store.get(key);
    return item ? mapper(item) : undefined;
  }
  private async list<T>(
    indexName: string | undefined,
    partitionKey: 'pk' | 'gsi1pk' | 'gsi2pk',
    partitionValue: string,
    sortKeyPrefix: string | undefined,
    options: ListOptions,
    mapper: (item: Record<string, unknown>) => T
  ): Promise<Page<T>> {
    const input = {
      partitionKey,
      partitionValue,
      ...(indexName ? { indexName } : {}),
      ...(sortKeyPrefix ? { sortKeyPrefix } : {}),
      limit: options.limit ?? 25,
      ...(decodePageToken(options.nextToken) ? { cursor: decodePageToken(options.nextToken) } : {})
    };
    const result = await this.store.query(input);
    return page(result.items.map(mapper), encodePageToken(result.nextKey));
  }
}

function awsConnectionChanges(
  value: Pick<AwsConnection, 'status' | 'updatedAt'> & Partial<AwsConnection>
): Record<string, unknown> {
  return {
    status: value.status,
    updatedAt: value.updatedAt,
    ...(value.verifiedAt ? { verifiedAt: value.verifiedAt } : {}),
    ...(value.lastVerifiedAt ? { lastVerifiedAt: value.lastVerifiedAt } : {}),
    ...(value.lastVerificationErrorCode
      ? { lastVerificationErrorCode: value.lastVerificationErrorCode }
      : {})
  };
}
