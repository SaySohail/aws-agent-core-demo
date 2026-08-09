import { createHash, randomUUID } from 'node:crypto';
import {
  createAwsConnectionRequestSchema,
  agentIdSchema,
  agentTemplateIdSchema,
  awsConnectionIdSchema,
  createAgentRequestSchema,
  createAuditEventId,
  bedrockModelCatalog,
  customerSupportTemplate,
  type AgentConfiguration,
  type AgentTemplate,
  deploymentIdSchema,
  pageQuerySchema,
  tenantIdSchema,
  updateAgentRequestSchema,
  type Agent,
  type AwsConnection,
  type MembershipRole,
  type TenantContext
} from '@agent-launchpad/schemas';
import {
  buildCustomerBootstrapQuickCreateUrl,
  customerArtifactBucketName,
  customerDeploymentRoleArn,
  CUSTOMER_BOOTSTRAP_VERSION,
  CUSTOMER_DEPLOYMENT_ROLE_NAME,
  ControlPlaneRepository,
  decodePageToken,
  type ListOptions,
  type Page
} from '@agent-launchpad/aws';
import type { CustomerRoleAssumer } from '@agent-launchpad/aws';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email?: string;
}

export interface HttpRequest {
  readonly requestId: string;
  readonly route: string;
  readonly method: string;
  readonly pathParameters?: Record<string, string | undefined>;
  readonly queryParameters?: Record<string, string | undefined>;
  readonly body?: string;
  readonly user?: AuthenticatedUser;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

export interface AwsConnectionOnboardingResponse extends Omit<AwsConnection, 'externalId'> {
  readonly quickCreateUrl: string;
}

export interface AwsConnectionConfiguration {
  readonly templateUrl: string;
  readonly trustedControlPlanePrincipalArn: string;
  readonly allowedRegions: readonly string[];
}

const defaultConnectionConfiguration: AwsConnectionConfiguration = {
  templateUrl: 'https://example.invalid/agent-launchpad/customer-bootstrap.template.json',
  trustedControlPlanePrincipalArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadControlApiRole',
  allowedRegions: ['us-east-1', 'us-west-2', 'eu-west-1']
};

export class ApiError extends Error {
  public constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const roles: Record<MembershipRole, readonly MembershipRole[]> = {
  MEMBER: ['MEMBER', 'ADMIN', 'OWNER'],
  ADMIN: ['ADMIN', 'OWNER'],
  OWNER: ['OWNER']
};

export function requireRole(context: TenantContext, minimum: MembershipRole): void {
  if (!roles[minimum].includes(context.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this operation.');
  }
}

function options(query: Record<string, string | undefined> | undefined): ListOptions {
  const parsed = parse(pageQuerySchema, query ?? {});
  if (parsed.nextToken) {
    try {
      decodePageToken(parsed.nextToken);
    } catch {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The pagination token is invalid.');
    }
  }
  return { limit: parsed.pageSize, ...(parsed.nextToken ? { nextToken: parsed.nextToken } : {}) };
}

function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains invalid input.');
  return result.data;
}

function body(request: HttpRequest): unknown {
  if (!request.body)
    throw new ApiError(400, 'VALIDATION_ERROR', 'A JSON request body is required.');
  try {
    return JSON.parse(request.body);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request body must be valid JSON.');
  }
}

function path(request: HttpRequest, key: string, schema: typeof tenantIdSchema): string;
function path(request: HttpRequest, key: string, schema: typeof agentIdSchema): string;
function path(request: HttpRequest, key: string, schema: typeof deploymentIdSchema): string;
function path(request: HttpRequest, key: string, schema: typeof agentTemplateIdSchema): string;
function path(
  request: HttpRequest,
  key: string,
  schema: { safeParse(value: unknown): { success: true; data: string } | { success: false } }
): string {
  return parse(schema, request.pathParameters?.[key]);
}

function success(data: unknown, statusCode = 200, page?: Page<unknown>): HttpResponse {
  return response(
    statusCode,
    page?.nextToken ? { data, page: { nextToken: page.nextToken } } : { data }
  );
}

function response(statusCode: number, value: unknown): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  };
}

function error(requestId: string, cause: unknown): HttpResponse {
  const apiError =
    cause instanceof ApiError
      ? cause
      : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  return response(apiError.statusCode, {
    error: { code: apiError.code, message: apiError.message, requestId }
  });
}

function asConflict(cause: unknown): never {
  if (
    cause instanceof Error &&
    /ConditionalCheckFailed|ConditionalCheckFailedException/.test(cause.name + cause.message)
  ) {
    throw new ApiError(409, 'CONFLICT', 'The resource already exists or was changed concurrently.');
  }
  throw cause;
}

export class ControlApi {
  public constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly connections: AwsConnectionConfiguration = defaultConnectionConfiguration,
    private readonly customerRoleAssumer?: CustomerRoleAssumer
  ) {}

  async handle(request: HttpRequest): Promise<HttpResponse> {
    const startedAt = Date.now();
    let tenantId: string | undefined;
    let result: HttpResponse;
    try {
      if (request.route === 'GET /health') result = success({ status: 'ok' });
      else {
        const user = this.user(request);
        if (request.route === 'GET /me') result = await this.me(user);
        else if (request.route === 'GET /tenants') result = await this.tenants(user, request);
        else if (request.route === 'GET /agent-templates') result = await this.templates(request);
        else if (request.route === 'GET /agent-templates/{templateId}/versions/{version}')
          result = await this.template(request);
        else {
          tenantId = path(request, 'tenantId', tenantIdSchema);
          const context = await this.context(user, tenantId);
          result = await this.tenantRoute(context, request);
        }
      }
    } catch (cause) {
      result = error(request.requestId, cause);
    }
    console.log(
      JSON.stringify({
        requestId: request.requestId,
        route: request.route,
        method: request.method,
        userId: request.user?.id,
        tenantId,
        statusCode: result.statusCode,
        durationMs: Date.now() - startedAt
      })
    );
    return result;
  }

  private user(request: HttpRequest): AuthenticatedUser {
    if (!request.user?.id)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    return request.user;
  }

  private async context(user: AuthenticatedUser, tenantId: string): Promise<TenantContext> {
    const context = await this.repository.resolveTenantContext(user.id, tenantId);
    if (!context) throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this tenant.');
    return context;
  }

  private async me(user: AuthenticatedUser): Promise<HttpResponse> {
    const memberships = await this.repository.listTenantContexts(user.id);
    return success({
      user: { id: user.id, ...(user.email ? { email: user.email } : {}) },
      tenants: memberships.items
    });
  }

  private async tenants(user: AuthenticatedUser, request: HttpRequest): Promise<HttpResponse> {
    const listed = await this.repository.listTenantContexts(
      user.id,
      options(request.queryParameters)
    );
    const items = await Promise.all(
      listed.items.map(async (context) => ({
        ...(await this.repository.getTenant(context.tenantId))!,
        role: context.role
      }))
    );
    return success(items, 200, listed);
  }

  private async templates(request: HttpRequest): Promise<HttpResponse> {
    await this.ensurePlatformTemplates();
    const listed = await this.repository.listAgentTemplates(options(request.queryParameters));
    return success(listed.items, 200, listed);
  }

  private async template(request: HttpRequest): Promise<HttpResponse> {
    await this.ensurePlatformTemplates();
    const template = await this.repository.getAgentTemplate(
      path(request, 'templateId', agentTemplateIdSchema),
      parseVersion(request.pathParameters?.version)
    );
    if (!template) throw new ApiError(404, 'NOT_FOUND', 'The agent template was not found.');
    return success(template);
  }

  private async tenantRoute(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    const listOptions = () => options(request.queryParameters);
    if (request.route === 'GET /tenants/{tenantId}') {
      return success((await this.repository.getTenant(context.tenantId))!);
    }
    if (request.route === 'GET /tenants/{tenantId}/agents') {
      const listed = await this.repository.listAgents(context.tenantId, listOptions());
      return success(listed.items, 200, listed);
    }
    if (request.route === 'GET /tenants/{tenantId}/agents/{agentId}')
      return success(await this.agent(context, request));
    if (request.route === 'POST /tenants/{tenantId}/agents')
      return this.createAgent(context, request);
    if (request.route === 'PATCH /tenants/{tenantId}/agents/{agentId}')
      return this.updateAgent(context, request);
    if (request.route === 'GET /tenants/{tenantId}/aws-connections') {
      const listed = await this.repository.listAwsConnections(context.tenantId, listOptions());
      return success(
        listed.items.map((connection) => this.onboarding(connection)),
        200,
        listed
      );
    }
    if (request.route === 'POST /tenants/{tenantId}/aws-connections')
      return this.createAwsConnection(context, request);
    if (request.route === 'GET /tenants/{tenantId}/aws-connections/{connectionId}') {
      const connection = await this.repository.getAwsConnection(
        context.tenantId,
        parseAwsConnectionId(request.pathParameters?.connectionId)
      );
      if (!connection) throw new ApiError(404, 'NOT_FOUND', 'The AWS connection was not found.');
      return success(this.onboarding(connection));
    }
    if (request.route === 'POST /tenants/{tenantId}/aws-connections/{connectionId}/verify')
      return this.verifyAwsConnection(context, request);
    if (request.route === 'GET /tenants/{tenantId}/deployments') {
      const listed = await this.repository.listDeployments(context.tenantId, listOptions());
      return success(listed.items, 200, listed);
    }
    if (request.route === 'GET /tenants/{tenantId}/deployments/{deploymentId}') {
      const deployment = await this.repository.getDeployment(
        context.tenantId,
        path(request, 'deploymentId', deploymentIdSchema)
      );
      if (!deployment) throw new ApiError(404, 'NOT_FOUND', 'The deployment was not found.');
      return success(deployment);
    }
    if (request.route === 'GET /tenants/{tenantId}/agents/{agentId}/deployments') {
      const agentId = path(request, 'agentId', agentIdSchema);
      if (!(await this.repository.getAgent(context.tenantId, agentId)))
        throw new ApiError(404, 'NOT_FOUND', 'The agent was not found.');
      const listed = await this.repository.listDeploymentsForAgent(
        context.tenantId,
        agentId,
        listOptions()
      );
      return success(listed.items, 200, listed);
    }
    throw new ApiError(404, 'NOT_FOUND', 'The requested route was not found.');
  }

  private onboarding(connection: AwsConnection): AwsConnectionOnboardingResponse {
    return {
      id: connection.id,
      tenantId: connection.tenantId,
      accountId: connection.accountId,
      region: connection.region,
      roleArn: connection.roleArn,
      status: connection.status,
      ...(connection.bootstrapVersion ? { bootstrapVersion: connection.bootstrapVersion } : {}),
      createdBy: connection.createdBy,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      ...(connection.verifiedAt ? { verifiedAt: connection.verifiedAt } : {}),
      ...(connection.lastVerifiedAt ? { lastVerifiedAt: connection.lastVerifiedAt } : {}),
      ...(connection.lastVerificationErrorCode
        ? { lastVerificationErrorCode: connection.lastVerificationErrorCode }
        : {}),
      quickCreateUrl: buildCustomerBootstrapQuickCreateUrl({
        region: connection.region,
        templateUrl: this.connections.templateUrl,
        trustedControlPlanePrincipalArn: this.connections.trustedControlPlanePrincipalArn,
        externalId: connection.externalId
      })
    };
  }

  private async createAwsConnection(
    context: TenantContext,
    request: HttpRequest
  ): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const input = parse(createAwsConnectionRequestSchema, body(request));
    if (!this.connections.allowedRegions.includes(input.region))
      throw new ApiError(400, 'VALIDATION_ERROR', 'The selected AWS region is not supported.');
    const now = this.clock().toISOString();
    // Deterministic ID plus conditional creation makes concurrent duplicate submits reuse one ExternalId.
    const id = stableConnectionId(context.tenantId, input.accountId, input.region);
    const connection: AwsConnection = {
      id,
      tenantId: context.tenantId,
      accountId: input.accountId,
      region: input.region,
      roleArn: customerDeploymentRoleArn(input.accountId),
      externalId: randomUUID(),
      status: 'PENDING',
      bootstrapVersion: CUSTOMER_BOOTSTRAP_VERSION,
      createdBy: context.userId,
      createdAt: now,
      updatedAt: now
    };
    try {
      await this.repository.createAwsConnection(connection);
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'AWS_CONNECTION_CREATED',
        resourceType: 'AWS_CONNECTION',
        resourceId: id,
        metadata: { accountId: input.accountId, region: input.region },
        createdAt: now
      });
      return success(this.onboarding(connection), 201);
    } catch (cause) {
      if (!isConditional(cause)) throw cause;
      const existing = await this.repository.getAwsConnection(context.tenantId, id);
      if (!existing) asConflict(cause);
      return success(this.onboarding(existing));
    }
  }

  private async verifyAwsConnection(
    context: TenantContext,
    request: HttpRequest
  ): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const id = parseAwsConnectionId(request.pathParameters?.connectionId);
    const connection = await this.repository.getAwsConnection(context.tenantId, id);
    if (!connection) throw new ApiError(404, 'NOT_FOUND', 'The AWS connection was not found.');
    if (!this.customerRoleAssumer)
      throw new ApiError(503, 'CONNECTION_NOT_READY', 'AWS verification is not configured.');
    validateConnectionRole(connection);
    const startedAt = this.clock().toISOString();
    try {
      await this.repository.startAwsConnectionVerification(context.tenantId, id, startedAt);
    } catch (cause) {
      if (isConditional(cause))
        throw new ApiError(409, 'CONFLICT', 'AWS connection verification is already in progress.');
      throw cause;
    }
    try {
      await verifyCustomerBootstrap(this.customerRoleAssumer, connection);
      const now = this.clock().toISOString();
      const verified: AwsConnection = {
        ...connection,
        status: 'VERIFIED',
        updatedAt: now,
        verifiedAt: connection.verifiedAt ?? now,
        lastVerifiedAt: now
      };
      await this.repository.completeAwsConnectionVerification(context.tenantId, id, verified);
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'AWS_CONNECTION_VERIFIED',
        resourceType: 'AWS_CONNECTION',
        resourceId: id,
        metadata: { accountId: connection.accountId, region: connection.region },
        createdAt: now
      });
      return success(this.onboarding(verified));
    } catch (cause) {
      const code = verificationErrorCode(cause);
      const now = this.clock().toISOString();
      await this.repository.completeAwsConnectionVerification(context.tenantId, id, {
        status: 'FAILED',
        updatedAt: now,
        lastVerificationErrorCode: code
      });
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'AWS_CONNECTION_VERIFICATION_FAILED',
        resourceType: 'AWS_CONNECTION',
        resourceId: id,
        metadata: { accountId: connection.accountId, region: connection.region, errorCode: code },
        createdAt: now
      });
      throw new ApiError(
        422,
        code,
        'AWS bootstrap could not be verified. Check the stack and retry.'
      );
    }
  }

  private async agent(context: TenantContext, request: HttpRequest): Promise<Agent> {
    const agent = await this.repository.getAgent(
      context.tenantId,
      path(request, 'agentId', agentIdSchema)
    );
    if (!agent) throw new ApiError(404, 'NOT_FOUND', 'The agent was not found.');
    return agent;
  }

  private async createAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const input = parse(createAgentRequestSchema, body(request));
    await this.ensurePlatformTemplates();
    const template = await this.repository.getAgentTemplate(
      input.templateId,
      input.templateVersion
    );
    if (!template || template.status !== 'ACTIVE')
      throw new ApiError(404, 'NOT_FOUND', 'The agent template version was not found.');
    const configuration = await this.normalizeAgentConfiguration(context, input, template);
    const now = this.clock().toISOString();
    const agent: Agent = {
      // The normalized draft is the idempotency identity for create retries/double-clicks.
      id: stableAgentId(context.tenantId, configuration),
      tenantId: context.tenantId,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      name: configuration.name,
      model: configuration.model.modelId,
      region: configuration.deploymentTarget.region,
      configuration,
      revision: 1,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now
    };
    try {
      await this.repository.createAgent(agent);
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'AGENT_CREATED',
        resourceType: 'AGENT',
        resourceId: agent.id,
        metadata: {
          templateId: agent.templateId,
          templateVersion: agent.templateVersion,
          region: agent.region
        },
        createdAt: now
      });
    } catch (cause) {
      if (!isConditional(cause)) throw cause;
      const existing = await this.repository.getAgent(context.tenantId, agent.id);
      if (!existing) asConflict(cause);
      return success(existing);
    }
    return success(agent, 201);
  }

  private async updateAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const agent = await this.agent(context, request);
    await this.ensurePlatformTemplates();
    if (agent.status !== 'DRAFT')
      throw new ApiError(409, 'CONFLICT', 'Only draft agents can be configured.');
    const changes = parse(updateAgentRequestSchema, body(request));
    const template = await this.repository.getAgentTemplate(
      changes.templateId,
      changes.templateVersion
    );
    if (!template || template.status !== 'ACTIVE')
      throw new ApiError(404, 'NOT_FOUND', 'The agent template version was not found.');
    const configuration = await this.normalizeAgentConfiguration(context, changes, template);
    const updatedAt = this.clock().toISOString();
    try {
      await this.repository.updateAgent(
        context,
        agent.id,
        {
          templateId: template.templateId,
          templateVersion: template.version,
          name: configuration.name,
          model: configuration.model.modelId,
          region: configuration.deploymentTarget.region,
          configuration,
          revision: agent.revision + 1,
          updatedAt
        },
        changes.expectedRevision
      );
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'AGENT_CONFIGURATION_UPDATED',
        resourceType: 'AGENT',
        resourceId: agent.id,
        metadata: {
          templateId: template.templateId,
          templateVersion: template.version,
          revision: agent.revision + 1
        },
        createdAt: updatedAt
      });
    } catch (cause) {
      asConflict(cause);
    }
    return success({
      ...agent,
      templateId: template.templateId,
      templateVersion: template.version,
      name: configuration.name,
      model: configuration.model.modelId,
      region: configuration.deploymentTarget.region,
      configuration,
      revision: agent.revision + 1,
      updatedAt
    });
  }

  private async normalizeAgentConfiguration(
    context: TenantContext,
    input: {
      name: string;
      templateId: string;
      templateVersion: string;
      modelId: string;
      awsConnectionId: string;
      capabilities: readonly string[];
      guardrails: {
        refunds: {
          enabled: boolean;
          autoApprovalLimitCents?: number | undefined;
          currency?: 'GBP' | undefined;
        };
      };
    },
    template: AgentTemplate
  ): Promise<AgentConfiguration> {
    const connection = await this.repository.getAwsConnection(
      context.tenantId,
      input.awsConnectionId
    );
    if (!connection) throw new ApiError(404, 'NOT_FOUND', 'The AWS connection was not found.');
    if (connection.status !== 'VERIFIED')
      throw new ApiError(422, 'CONNECTION_NOT_READY', 'Select a verified AWS connection.');
    const model = bedrockModelCatalog.find((value) => value.modelId === input.modelId);
    if (
      !model ||
      model.status !== 'ACTIVE' ||
      model.runtimeApi !== 'BEDROCK_CONVERSE' ||
      !model.allowedTemplateIds.includes(template.templateId) ||
      !model.supportedRegions.includes(connection.region)
    )
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'The selected model is not supported in the target region.'
      );
    if (
      new Set(input.capabilities).size !== input.capabilities.length ||
      input.capabilities.some(
        (capability) => !template.supportedCapabilities.includes(capability as never)
      )
    )
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'One or more selected capabilities are not supported.'
      );
    const refundsEnabled = input.capabilities.includes('PROCESS_REFUND');
    const suppliedRefunds = input.guardrails.refunds;
    if (refundsEnabled) {
      if (
        !suppliedRefunds.enabled ||
        !suppliedRefunds.autoApprovalLimitCents ||
        suppliedRefunds.currency !== template.guardrails.refunds.currency ||
        suppliedRefunds.autoApprovalLimitCents >
          template.guardrails.refunds.maximumAutoApprovalLimitCents
      )
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'The refund automatic-approval limit is invalid.'
        );
    }
    return {
      configurationVersion: 1,
      template: { id: template.templateId, version: template.version },
      name: input.name.trim(),
      deploymentTarget: {
        awsConnectionId: connection.id,
        accountId: connection.accountId,
        region: connection.region
      },
      model: { modelId: model.modelId },
      capabilities: [...input.capabilities] as AgentConfiguration['capabilities'],
      guardrails: {
        refunds: refundsEnabled
          ? {
              enabled: true,
              autoApprovalLimitCents: suppliedRefunds.autoApprovalLimitCents,
              currency: suppliedRefunds.currency
            }
          : { enabled: false }
      }
    };
  }

  /** A platform-owned seed is conditional and has no tenant/user mutation route. */
  private async ensurePlatformTemplates(): Promise<void> {
    try {
      await this.repository.createAgentTemplate(customerSupportTemplate);
    } catch (cause) {
      if (!isConditional(cause)) throw cause;
    }
  }
}

function parseVersion(value: unknown): string {
  return parse(
    {
      safeParse: (candidate) =>
        typeof candidate === 'string' && candidate.trim() && candidate.length <= 100
          ? { success: true as const, data: candidate.trim() }
          : { success: false as const }
    },
    value
  );
}
function parseAwsConnectionId(value: unknown): string {
  return parse(awsConnectionIdSchema, value);
}

function stableConnectionId(tenantId: string, accountId: string, region: string): string {
  const hex = createHash('sha1').update(`${tenantId}:${accountId}:${region}`).digest('hex');
  return `awc_${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function stableAgentId(tenantId: string, configuration: AgentConfiguration): string {
  const hex = createHash('sha1')
    .update(`${tenantId}:${JSON.stringify(configuration)}`)
    .digest('hex');
  return `agt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isConditional(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    /ConditionalCheckFailed|ConditionalCheckFailedException/.test(cause.name + cause.message)
  );
}

function validateConnectionRole(connection: AwsConnection): void {
  const expected = customerDeploymentRoleArn(connection.accountId);
  if (connection.roleArn !== expected)
    throw new ApiError(422, 'CONNECTION_NOT_READY', 'AWS connection metadata is invalid.');
}

async function verifyCustomerBootstrap(
  assumer: CustomerRoleAssumer,
  connection: AwsConnection
): Promise<void> {
  const credentials = await withRetry(() =>
    assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `agent-launchpad-verify-${connection.id.slice(-12)}`
    })
  );
  const identity = await assumer.getCallerIdentity(credentials);
  if (identity.account !== connection.accountId) throw new VerificationFailure('ACCOUNT_MISMATCH');
  const expectedArn = new RegExp(
    `^arn:aws:sts::${connection.accountId}:assumed-role/${CUSTOMER_DEPLOYMENT_ROLE_NAME}/[^/]+$`
  );
  if (!identity.arn || !expectedArn.test(identity.arn))
    throw new VerificationFailure('ROLE_IDENTITY_MISMATCH');
  try {
    await assumer.headArtifactBucket(
      credentials,
      customerArtifactBucketName(connection.accountId, connection.region),
      connection.region
    );
  } catch (cause) {
    if (isAccessDenied(cause)) throw new VerificationFailure('BOOTSTRAP_ACCESS_DENIED');
    throw new VerificationFailure('BOOTSTRAP_RESOURCE_MISSING');
  }
}

class VerificationFailure extends Error {
  public constructor(readonly code: string) {
    super(code);
  }
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (const delay of [0, 100, 300]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (cause) {
      last = cause;
      if (!isTransient(cause)) throw cause;
    }
  }
  throw last;
}

function isAccessDenied(cause: unknown): boolean {
  return cause instanceof Error && /AccessDenied|Forbidden/.test(cause.name + cause.message);
}
function isTransient(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    /Timeout|Networking|ServiceUnavailable|Throttl|RequestLimit/.test(cause.name + cause.message)
  );
}
function verificationErrorCode(cause: unknown): string {
  if (cause instanceof VerificationFailure) return cause.code;
  if (isAccessDenied(cause)) return 'ASSUME_ROLE_DENIED';
  if (isTransient(cause)) return 'AWS_TEMPORARY_ERROR';
  return 'CONNECTION_NOT_READY';
}
