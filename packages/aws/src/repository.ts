import {
  agentSchema,
  type Agent,
  type AgentTemplate,
  type AuditEvent,
  type AwsConnection,
  type Deployment,
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
  async updateAgent(
    context: TenantContext,
    agentId: string,
    changes: Partial<
      Pick<
        Agent,
        'name' | 'model' | 'region' | 'status' | 'runtimeArn' | 'runtimeVersion' | 'runtimeEndpoint'
      >
    > &
      Pick<Agent, 'updatedAt'>
  ): Promise<void> {
    const parsed = agentSchema
      .pick({
        name: true,
        model: true,
        region: true,
        status: true,
        runtimeArn: true,
        runtimeVersion: true,
        runtimeEndpoint: true,
        updatedAt: true
      })
      .partial()
      .required({ updatedAt: true })
      .parse(changes);
    await this.store.update({
      key: controlPlaneKeys.agent(context.tenantId, agentId),
      updates: parsed,
      condition: existingCondition
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
