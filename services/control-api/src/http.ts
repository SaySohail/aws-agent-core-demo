import { createHash, randomUUID } from 'node:crypto';
import {
  createAwsConnectionRequestSchema,
  agentIdSchema,
  agentTemplateIdSchema,
  awsConnectionIdSchema,
  createAgentRequestSchema,
  createAuditEventId,
  createExecutionId,
  createDeploymentEventId,
  createDeploymentId,
  bedrockModelCatalog,
  customerSupportTemplate,
  type AgentConfiguration,
  type AgentTemplate,
  deploymentIdSchema,
  pageQuerySchema,
  tenantIdSchema,
  updateAgentRequestSchema,
  playgroundInvokeRequestSchema,
  rollbackRequestSchema,
  undeployRequestSchema,
  playgroundInvokeResponseSchema,
  type Agent,
  type AwsConnection,
  type Deployment,
  type DeploymentDetail,
  type MembershipRole,
  type TenantContext,
  auditActions,
  type AgentExecutionSummary
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
import {
  AgentCoreSecurityError,
  AgentRuntimeInvoker,
  RuntimeInvocationError,
  type AgentRuntimeInvocationClient
} from '@agent-launchpad/aws';

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
  readonly headers?: Record<string, string | undefined>;
  readonly user?: AuthenticatedUser;
}

/** The API starts a durable workflow; it never runs deployment work in the request. */
export interface DeploymentWorkflowStarter {
  start(input: {
    deploymentId: string;
    tenantId: string;
    agentId: string;
    configurationRevision: number;
    artifactId?: string;
  }): Promise<{ executionArn: string }>;
}

const retryableDeploymentErrorCodes = new Set(['AGENTCORE_THROTTLED']);

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

function runtimeInvocationApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof AgentCoreSecurityError)
    return new ApiError(
      403,
      'RUNTIME_FORBIDDEN',
      'The deployed agent can no longer be invoked with the configured AWS access.'
    );
  if (!(cause instanceof RuntimeInvocationError))
    return new ApiError(
      503,
      'RUNTIME_UNAVAILABLE',
      'The deployed agent is temporarily unavailable.'
    );
  const mapped: Record<RuntimeInvocationError['code'], readonly [number, string, string]> = {
    RUNTIME_INVALID_REQUEST: [
      400,
      'RUNTIME_INVALID_REQUEST',
      'The deployed agent rejected this request.'
    ],
    RUNTIME_QUOTA_EXCEEDED: [
      429,
      'RUNTIME_QUOTA_EXCEEDED',
      'The deployed agent is temporarily busy. Try again shortly.'
    ],
    RUNTIME_FORBIDDEN: [
      403,
      'RUNTIME_FORBIDDEN',
      'The deployed agent can no longer be invoked with the configured AWS access.'
    ],
    RUNTIME_NOT_FOUND: [
      404,
      'RUNTIME_NOT_FOUND',
      'The deployed Runtime could not be found. A redeployment may be required.'
    ],
    RUNTIME_CONFLICT: [
      409,
      'RUNTIME_CONFLICT',
      'The deployed agent is being updated. Try again shortly.'
    ],
    RUNTIME_CLIENT_ERROR: [
      502,
      'RUNTIME_CLIENT_ERROR',
      'The deployed agent could not complete the request.'
    ],
    RUNTIME_THROTTLED: [
      429,
      'RUNTIME_THROTTLED',
      'The deployed agent is temporarily busy. Try again shortly.'
    ],
    RUNTIME_UNAVAILABLE: [
      503,
      'RUNTIME_UNAVAILABLE',
      'The deployed agent is temporarily unavailable.'
    ],
    RUNTIME_TIMEOUT: [
      504,
      'RUNTIME_TIMEOUT',
      'The agent did not complete the request in time. The request may already have triggered a tool action, so verify the result before retrying.'
    ],
    INVALID_RUNTIME_RESPONSE: [
      502,
      'INVALID_RUNTIME_RESPONSE',
      'The deployed agent returned an invalid response.'
    ],
    RUNTIME_RESPONSE_TOO_LARGE: [
      502,
      'RUNTIME_RESPONSE_TOO_LARGE',
      'The deployed agent returned an invalid response.'
    ]
  };
  const [statusCode, code, message] = mapped[cause.code];
  return new ApiError(statusCode, code, message);
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

function normalizedIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(normalized))
    throw new ApiError(400, 'VALIDATION_ERROR', 'A valid Idempotency-Key header is required.');
  return normalized;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class ControlApi {
  public constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly connections: AwsConnectionConfiguration = defaultConnectionConfiguration,
    private readonly customerRoleAssumer?: CustomerRoleAssumer,
    private readonly workflowStarter?: DeploymentWorkflowStarter,
    private readonly runtimeInvoker: AgentRuntimeInvocationClient = new AgentRuntimeInvoker()
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
    if (request.route === 'POST /tenants/{tenantId}/agents/{agentId}/deploy')
      return this.deployAgent(context, request);
    if (request.route === 'POST /tenants/{tenantId}/agents/{agentId}/undeploy')
      return this.undeployAgent(context, request);
    if (request.route === 'POST /tenants/{tenantId}/agents/{agentId}/invoke')
      return this.invokeAgent(context, request);
    if (request.route === 'GET /tenants/{tenantId}/agents/{agentId}/executions')
      return this.executions(context, request);
    if (request.route === 'GET /tenants/{tenantId}/agents/{agentId}/metrics')
      return this.metrics(context, request);
    if (request.route === 'GET /tenants/{tenantId}/audit-events')
      return this.auditEvents(context, request);
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
      return success(await this.deploymentDetail(context, deployment));
    }
    if (request.route === 'POST /tenants/{tenantId}/deployments/{deploymentId}/retry')
      return this.retryDeployment(context, request);
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
    if (request.route === 'GET /tenants/{tenantId}/agents/{agentId}/versions')
      return this.listVersions(context, request);
    if (request.route === 'POST /tenants/{tenantId}/agents/{agentId}/rollback')
      return this.rollbackAgent(context, request);
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

  private async deploymentDetail(
    context: TenantContext,
    deployment: Deployment
  ): Promise<DeploymentDetail> {
    const [events, versions, agent] = await Promise.all([
      this.repository.listDeploymentEvents(context.tenantId, deployment.id, { limit: 100 }),
      this.repository.listRuntimeVersions(context.tenantId, deployment.agentId),
      this.repository.getAgent(context.tenantId, deployment.agentId)
    ]);
    if (!agent) throw new ApiError(404, 'NOT_FOUND', 'The deployment was not found.');
    const candidate = versions.find((version) => version.deploymentId === deployment.id);
    return {
      agentName: agent.name,
      deployment: {
        id: deployment.id,
        agentId: deployment.agentId,
        status: deployment.status,
        stage: deployment.stage,
        requestedBy: deployment.requestedBy,
        configurationRevision: deployment.configurationRevision,
        snapshot: deployment.snapshot,
        ...(deployment.runtimeVersion ? { runtimeVersion: deployment.runtimeVersion } : {}),
        ...(deployment.runtimeId ? { runtimeId: deployment.runtimeId } : {}),
        ...(deployment.runtimeEndpointArn
          ? { runtimeEndpointArn: deployment.runtimeEndpointArn }
          : {}),
        ...(deployment.runtimeEndpointName
          ? { runtimeEndpointName: deployment.runtimeEndpointName }
          : {}),
        ...(deployment.gatewayArn ? { gatewayArn: deployment.gatewayArn } : {}),
        createdAt: deployment.createdAt,
        ...(deployment.startedAt ? { startedAt: deployment.startedAt } : {}),
        ...(deployment.completedAt ? { completedAt: deployment.completedAt } : {}),
        ...(deployment.errorCode ? { errorCode: deployment.errorCode } : {})
      },
      events: events.items.map((event) => ({
        id: event.id,
        deploymentId: event.deploymentId,
        ...(event.fromStage ? { fromStage: event.fromStage } : {}),
        toStage: event.toStage,
        status: event.status,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        createdAt: event.createdAt
      })),
      ...(candidate
        ? {
            candidateRuntimeVersion: {
              id: candidate.id,
              agentId: candidate.agentId,
              deploymentId: candidate.deploymentId,
              runtimeId: candidate.runtimeId,
              runtimeArn: candidate.runtimeArn,
              runtimeVersion: candidate.runtimeVersion,
              artifactId: candidate.artifactId,
              artifactSha256: candidate.artifactSha256,
              configurationRevision: candidate.configurationRevision,
              state: candidate.state,
              ...(candidate.endpointName ? { endpointName: candidate.endpointName } : {}),
              ...(candidate.endpointArn ? { endpointArn: candidate.endpointArn } : {}),
              ...(candidate.endpointTargetVersion
                ? { endpointTargetVersion: candidate.endpointTargetVersion }
                : {}),
              ...(candidate.endpointLiveVersion
                ? { endpointLiveVersion: candidate.endpointLiveVersion }
                : {}),
              createdAt: candidate.createdAt,
              updatedAt: candidate.updatedAt
            }
          }
        : {}),
      production: {
        ...(agent.runtimeArn ? { runtimeArn: agent.runtimeArn } : {}),
        ...(agent.runtimeId ? { runtimeId: agent.runtimeId } : {}),
        ...(agent.runtimeEndpoint ? { endpointArn: agent.runtimeEndpoint } : {}),
        ...(agent.runtimeEndpointName ? { endpointName: agent.runtimeEndpointName } : {}),
        ...(agent.runtimeVersion ? { liveVersion: agent.runtimeVersion } : {})
      },
      retryable:
        deployment.status === 'FAILED' &&
        Boolean(deployment.errorCode && retryableDeploymentErrorCodes.has(deployment.errorCode)),
      currentConfigurationRevision: agent.revision
    };
  }

  private async retryDeployment(
    context: TenantContext,
    request: HttpRequest
  ): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const source = await this.repository.getDeployment(
      context.tenantId,
      path(request, 'deploymentId', deploymentIdSchema)
    );
    if (!source) throw new ApiError(404, 'NOT_FOUND', 'The deployment was not found.');
    if (
      source.status !== 'FAILED' ||
      !source.errorCode ||
      !retryableDeploymentErrorCodes.has(source.errorCode)
    )
      throw new ApiError(409, 'RETRY_NOT_AVAILABLE', 'This deployment is not eligible for retry.');
    const lock = await this.repository.getDeploymentLock(context.tenantId, source.agentId);
    if (lock)
      throw new ApiError(
        409,
        'DEPLOYMENT_ALREADY_IN_PROGRESS',
        `A deployment is already in progress: ${lock.deploymentId}.`
      );
    if (!this.workflowStarter)
      throw new ApiError(
        503,
        'DEPLOYMENT_UNAVAILABLE',
        'Deployment orchestration is not configured.'
      );
    const idempotencyKeyHash = hash(normalizedIdempotencyKey(request.headers?.['idempotency-key']));
    const existing = await this.repository.getDeploymentByIdempotency(
      context.tenantId,
      source.agentId,
      idempotencyKeyHash
    );
    if (existing) {
      const deployment = await this.repository.getDeployment(
        context.tenantId,
        existing.deploymentId
      );
      if (deployment)
        return success({ deploymentId: deployment.id, status: deployment.status }, 202);
    }
    const now = this.clock().toISOString();
    const deploymentId = createDeploymentId();
    const retried: Deployment = {
      id: deploymentId,
      tenantId: source.tenantId,
      agentId: source.agentId,
      status: 'QUEUED',
      stage: 'QUEUED',
      requestedBy: context.userId,
      configurationRevision: source.configurationRevision,
      snapshot: source.snapshot,
      idempotencyKeyHash,
      requestHash: hash(`retry:${source.id}:${idempotencyKeyHash}`),
      createdAt: now
    };
    await this.repository.acquireDeploymentLock({
      tenantId: context.tenantId,
      agentId: source.agentId,
      deploymentId,
      configurationRevision: source.configurationRevision,
      acquiredAt: now
    });
    await this.repository.createDeploymentIdempotency({
      tenantId: context.tenantId,
      agentId: source.agentId,
      idempotencyKeyHash,
      requestHash: retried.requestHash,
      deploymentId,
      createdAt: now
    });
    await this.repository.createDeployment(retried);
    await this.repository.appendDeploymentEvent({
      id: createDeploymentEventId(),
      tenantId: context.tenantId,
      deploymentId,
      toStage: 'QUEUED',
      status: 'QUEUED',
      createdAt: now
    });
    const execution = await this.workflowStarter.start({
      deploymentId,
      tenantId: context.tenantId,
      agentId: source.agentId,
      configurationRevision: source.configurationRevision,
      ...(source.snapshot.artifactId ? { artifactId: source.snapshot.artifactId } : {})
    });
    await this.repository.setDeploymentExecutionArn(
      context.tenantId,
      deploymentId,
      execution.executionArn
    );
    return success({ deploymentId, status: 'QUEUED' }, 202);
  }

  private async listVersions(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    const agent = await this.agent(context, request);
    const listed = await this.repository.listRuntimeVersionsPage(context.tenantId, agent.id, options(request.queryParameters));
    const active = await this.repository.getDeploymentLock(context.tenantId, agent.id);
    return success(
      listed.items.map((version) => ({
        runtimeVersion: version.runtimeVersion,
        status: version.state,
        artifactId: version.artifactId,
        artifactSha256: version.artifactSha256,
        configurationRevision: version.configurationRevision,
        deploymentId: version.deploymentId,
        createdAt: version.createdAt,
        deployedAt: version.updatedAt,
        currentProduction: version.runtimeVersion === agent.runtimeVersion,
        previouslyProduction: Boolean(version.productionPromotedAt),
        productionPromotedAt: version.productionPromotedAt,
        rollbackEligible:
          !active &&
          version.state === 'READY' &&
          Boolean(version.productionPromotedAt) &&
          version.runtimeId === agent.runtimeId &&
          version.runtimeVersion !== agent.runtimeVersion,
        ...(active
          ? { rollbackUnavailableReason: 'A lifecycle operation is in progress.' }
          : version.runtimeVersion === agent.runtimeVersion
            ? { rollbackUnavailableReason: 'This version is already serving production.' }
            : version.state !== 'READY'
              ? { rollbackUnavailableReason: 'Runtime version is not ready.' }
              : !version.productionPromotedAt
                ? { rollbackUnavailableReason: 'Not previously promoted.' }
                : version.runtimeId !== agent.runtimeId
                  ? { rollbackUnavailableReason: 'Runtime does not match production.' }
                  : {})
      })),
      200,
      listed
    );
  }

  private async rollbackAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const agent = await this.agent(context, request);
    const input = parse(rollbackRequestSchema, body(request));
    if (!agent.runtimeId || !agent.runtimeVersion)
      throw new ApiError(409, 'ROLLBACK_TARGET_NOT_FOUND', 'Production Runtime metadata is unavailable.');
    const key = normalizedIdempotencyKey(request.headers?.['idempotency-key'] ?? request.headers?.['Idempotency-Key']);
    const idempotencyKeyHash = hash(key);
    const requestHash = hash(JSON.stringify({ tenantId: context.tenantId, agentId: agent.id, from: agent.runtimeVersion, target: input.targetRuntimeVersion }));
    const existing = await this.repository.getDeploymentByIdempotency(context.tenantId, agent.id, idempotencyKeyHash);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different rollback request.');
      const operation = await this.repository.getDeployment(context.tenantId, existing.deploymentId);
      if (!operation) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The previous rollback cannot be recovered.');
      return success({ deploymentId: operation.id, status: operation.status }, 202);
    }
    const versions = await this.repository.listRuntimeVersions(context.tenantId, agent.id);
    const target = versions.find((value) => value.runtimeVersion === input.targetRuntimeVersion);
    if (!target) throw new ApiError(404, 'ROLLBACK_TARGET_NOT_FOUND', 'The requested Runtime version was not found.');
    if (target.runtimeId !== agent.runtimeId) throw new ApiError(409, 'ROLLBACK_TARGET_NOT_FOUND', 'The requested Runtime version does not belong to production.');
    if (target.runtimeVersion === agent.runtimeVersion) throw new ApiError(409, 'ROLLBACK_TARGET_NOT_READY', 'This version is already serving production.');
    if (target.state !== 'READY') throw new ApiError(409, 'ROLLBACK_TARGET_NOT_READY', 'The requested Runtime version is not ready.');
    if (!target.productionPromotedAt) throw new ApiError(409, 'ROLLBACK_TARGET_NOT_PREVIOUSLY_PRODUCTION', 'The requested Runtime version was not previously promoted.');
    const current = versions.find((value) => value.runtimeVersion === agent.runtimeVersion);
    if (!current?.compatibilityFingerprint || !target.compatibilityFingerprint || current.compatibilityFingerprint !== target.compatibilityFingerprint)
      throw new ApiError(409, 'ROLLBACK_VERSION_INCOMPATIBLE', 'The Runtime version is incompatible with the current data-plane contract.');
    const source = (await this.repository.listDeploymentsForAgent(context.tenantId, agent.id, { limit: 100 })).items.find((value) => value.status === 'READY');
    if (!source) throw new ApiError(409, 'ROLLBACK_TARGET_NOT_FOUND', 'The trusted deployment snapshot is unavailable.');
    if (!this.workflowStarter) throw new ApiError(503, 'DEPLOYMENT_UNAVAILABLE', 'Deployment orchestration is not configured.');
    const now = this.clock().toISOString();
    const deploymentId = createDeploymentId();
    const operation: Deployment = {
      id: deploymentId, tenantId: context.tenantId, agentId: agent.id, operationType: 'ROLLBACK',
      fromRuntimeVersion: agent.runtimeVersion, targetRuntimeVersion: target.runtimeVersion,
      status: 'QUEUED', stage: 'QUEUED', requestedBy: context.userId,
      configurationRevision: agent.revision, snapshot: source.snapshot,
      idempotencyKeyHash, requestHash, createdAt: now
    };
    try {
      await this.repository.acquireDeploymentLock({ tenantId: context.tenantId, agentId: agent.id, deploymentId, configurationRevision: agent.revision, acquiredAt: now });
    } catch (cause) {
      if (isConditional(cause)) throw new ApiError(409, 'DEPLOYMENT_ALREADY_IN_PROGRESS', 'A lifecycle operation is already in progress for this agent.');
      throw cause;
    }
    await this.repository.createDeploymentIdempotency({ tenantId: context.tenantId, agentId: agent.id, idempotencyKeyHash, requestHash, deploymentId, createdAt: now });
    await this.repository.createDeployment(operation);
    await this.repository.appendDeploymentEvent({ id: createDeploymentEventId(), tenantId: context.tenantId, deploymentId, toStage: 'QUEUED', status: 'QUEUED', createdAt: now });
    await this.repository.appendAuditEvent({ id: createAuditEventId(), tenantId: context.tenantId, actorId: context.userId, action: auditActions.ROLLBACK_REQUESTED, resourceType: 'DEPLOYMENT', resourceId: deploymentId, metadata: { agentId: agent.id, fromVersion: agent.runtimeVersion, targetVersion: target.runtimeVersion }, createdAt: now });
    const execution = await this.workflowStarter.start({ deploymentId, tenantId: context.tenantId, agentId: agent.id, configurationRevision: agent.revision });
    await this.repository.setDeploymentExecutionArn(context.tenantId, deploymentId, execution.executionArn);
    return success({ deploymentId, status: 'QUEUED' }, 202);
  }

  private async undeployAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const agent = await this.agent(context, request);
    parse(undeployRequestSchema, body(request));
    if (agent.status !== 'ACTIVE' || !agent.runtimeId)
      throw new ApiError(409, 'UNDEPLOY_NOT_AVAILABLE', 'Only an active deployed agent can be undeployed.');
    if (!this.workflowStarter)
      throw new ApiError(503, 'DEPLOYMENT_UNAVAILABLE', 'Deployment orchestration is not configured.');
    const key = normalizedIdempotencyKey(request.headers?.['idempotency-key'] ?? request.headers?.['Idempotency-Key']);
    const idempotencyKeyHash = hash(key);
    const artifacts = (await this.repository.listAgentArtifacts(context.tenantId, { limit: 100 })).items
      .filter((artifact) => artifact.agentId === agent.id && artifact.status === 'READY')
      .sort((left, right) => left.id.localeCompare(right.id));
    const requestHash = hash(JSON.stringify({
      tenantId: context.tenantId, agentId: agent.id, operation: 'UNDEPLOY', runtimeId: agent.runtimeId,
      endpoint: agent.runtimeEndpointName ?? 'production', artifacts: artifacts.map((artifact) => [artifact.id, artifact.bucket, artifact.objectKey, artifact.s3VersionId])
    }));
    const existing = await this.repository.getDeploymentByIdempotency(context.tenantId, agent.id, idempotencyKeyHash);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different undeploy request.');
      const operation = await this.repository.getDeployment(context.tenantId, existing.deploymentId);
      if (!operation) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'The previous undeploy cannot be recovered.');
      return success({ deploymentId: operation.id, status: operation.status }, 202);
    }
    const source = (await this.repository.listDeploymentsForAgent(context.tenantId, agent.id, { limit: 100 })).items
      .find((deployment) => deployment.status === 'READY');
    if (!source) throw new ApiError(409, 'UNDEPLOY_PLAN_UNAVAILABLE', 'Trusted deployment metadata is unavailable.');
    const now = this.clock().toISOString();
    const deploymentId = createDeploymentId();
    const operation: Deployment = {
      id: deploymentId, tenantId: context.tenantId, agentId: agent.id, operationType: 'UNDEPLOY',
      status: 'QUEUED', stage: 'UNDEPLOY_QUEUED', requestedBy: context.userId, configurationRevision: agent.revision,
      snapshot: source.snapshot, idempotencyKeyHash, requestHash, createdAt: now,
      cleanupPlan: {
        runtimeId: agent.runtimeId, ...(agent.runtimeArn ? { runtimeArn: agent.runtimeArn } : {}),
        endpointName: 'production', ...(agent.runtimeEndpoint ? { endpointArn: agent.runtimeEndpoint } : {}),
        artifactIds: artifacts.map((artifact) => artifact.id), accountId: source.snapshot.accountId, region: source.snapshot.region
      },
      cleanupLedger: [
        { kind: 'RUNTIME_ENDPOINT', logicalId: `${agent.runtimeId}:production`, status: 'PENDING', updatedAt: now },
        { kind: 'RUNTIME', logicalId: agent.runtimeId, status: 'PENDING', updatedAt: now },
        ...artifacts.map((artifact) => ({ kind: 'ARTIFACT' as const, logicalId: artifact.id, status: 'PENDING' as const, updatedAt: now }))
      ]
    };
    try {
      await this.repository.acquireDeploymentLock({ tenantId: context.tenantId, agentId: agent.id, deploymentId, configurationRevision: agent.revision, acquiredAt: now });
    } catch (cause) {
      if (isConditional(cause)) {
        const lock = await this.repository.getDeploymentLock(context.tenantId, agent.id);
        throw new ApiError(409, 'DEPLOYMENT_ALREADY_IN_PROGRESS', `A lifecycle operation is already in progress (${lock?.deploymentId ?? 'unknown'}).`);
      }
      throw cause;
    }
    await this.repository.createDeploymentIdempotency({ tenantId: context.tenantId, agentId: agent.id, idempotencyKeyHash, requestHash, deploymentId, createdAt: now });
    await this.repository.createDeployment(operation);
    await this.repository.appendDeploymentEvent({ id: createDeploymentEventId(), tenantId: context.tenantId, deploymentId, toStage: 'UNDEPLOY_QUEUED', status: 'QUEUED', createdAt: now });
    await this.repository.appendAuditEvent({ id: createAuditEventId(), tenantId: context.tenantId, actorId: context.userId, action: auditActions.UNDEPLOY_REQUESTED, resourceType: 'DEPLOYMENT', resourceId: deploymentId, metadata: { agentId: agent.id, runtimeId: agent.runtimeId, resourceCount: operation.cleanupLedger?.length ?? 0 }, createdAt: now });
    await this.repository.markAgentUndeploying(context.tenantId, agent.id, now);
    const execution = await this.workflowStarter.start({ deploymentId, tenantId: context.tenantId, agentId: agent.id, configurationRevision: agent.revision });
    await this.repository.setDeploymentExecutionArn(context.tenantId, deploymentId, execution.executionArn);
    return success({ deploymentId, status: 'QUEUED' }, 202);
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
        action: auditActions.AWS_CONNECTION_CREATED,
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
        action: auditActions.AWS_CONNECTION_VERIFIED,
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
        action: auditActions.AWS_CONNECTION_VERIFICATION_FAILED,
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

  private async invokeAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const input = parse(playgroundInvokeRequestSchema, body(request));
    const agent = await this.agent(context, request);
    if (agent.status === 'UNDEPLOYING' || agent.status === 'UNDEPLOYED')
      throw new ApiError(409, 'PLAYGROUND_NOT_READY', 'This agent is being undeployed or is no longer deployed.');
    const [deployments, versions] = await Promise.all([
      this.repository.listDeploymentsForAgent(context.tenantId, agent.id, { limit: 100 }),
      this.repository.listRuntimeVersions(context.tenantId, agent.id)
    ]);
    const deployment = deployments.items.find(
      (value) =>
        value.status === 'READY' &&
        value.configurationRevision === agent.revision &&
        value.snapshot.awsConnectionId === agent.configuration.deploymentTarget.awsConnectionId
    );
    const version = versions.find(
      (value) =>
        value.state === 'READY' &&
        value.runtimeArn === agent.runtimeArn &&
        value.runtimeVersion === agent.runtimeVersion &&
        value.deploymentId === deployment?.id &&
        value.endpointName === 'production' &&
        value.endpointLiveVersion === agent.runtimeVersion
    );
    const connection = deployment
      ? await this.repository.getAwsConnection(
          context.tenantId,
          deployment.snapshot.awsConnectionId
        )
      : undefined;
    if (
      !deployment ||
      !version ||
      !agent.runtimeArn ||
      !agent.runtimeVersion ||
      agent.runtimeEndpointName !== 'production' ||
      !agent.runtimeEndpoint ||
      !connection ||
      connection.status !== 'VERIFIED' ||
      connection.accountId !== deployment.snapshot.accountId ||
      connection.region !== deployment.snapshot.region
    )
      throw new ApiError(
        409,
        'PLAYGROUND_NOT_READY',
        'The deployed production Runtime is not ready. Deploy or promote the agent first.'
      );
    if (!this.customerRoleAssumer)
      throw new ApiError(503, 'RUNTIME_UNAVAILABLE', 'Runtime invocation is not configured.');
    const executionId = createExecutionId();
    const started = this.clock();
    const runtimeSessionId = input.sessionId ?? randomUUID();
    try {
      const credentials = await this.customerRoleAssumer.assumeCustomerRole({
        roleArn: connection.roleArn,
        externalId: connection.externalId,
        sessionName: `playground-${agent.id}-${context.userId}`.slice(0, 64)
      });
      const result = await this.runtimeInvoker.invoke({
        runtimeArn: agent.runtimeArn,
        qualifier: 'production',
        sessionId: runtimeSessionId,
        payload: { prompt: input.prompt },
        credentials,
        connection
      });
      const completed = this.clock();
      const summary: AgentExecutionSummary = {
        executionId,
        tenantId: context.tenantId,
        agentId: agent.id,
        deploymentId: deployment.id,
        runtimeVersion: agent.runtimeVersion,
        endpointName: 'production',
        requestedBy: context.userId,
        status: 'SUCCEEDED',
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        toolActivity: result.toolActivity.map((activity) => ({
          tool: activity.tool,
          status: activity.status,
          ...(activity.durationMs === undefined ? {} : { durationMs: activity.durationMs }),
          ...(activity.reasonCode ? { safeReasonCode: activity.reasonCode } : {})
        })),
        policyDenialCount: result.toolActivity.filter((activity) => activity.status === 'DENIED')
          .length,
        ...(result.traceId ? { traceId: result.traceId } : {}),
        startedAt: started.toISOString(),
        completedAt: completed.toISOString()
      };
      await this.bestEffortObservabilityWrite('execution_summary_persistence_failed', async () => {
        await this.repository.createAgentExecutionSummary(summary);
      });
      await this.bestEffortObservabilityWrite('invocation_audit_persistence_failed', async () => {
        await this.repository.appendAuditEvent({
          id: createAuditEventId(),
          tenantId: context.tenantId,
          actorId: context.userId,
          action: auditActions.AGENT_INVOKED,
          resourceType: 'AGENT',
          resourceId: agent.id,
          metadata: {
            executionId,
            deploymentId: deployment.id,
            runtimeVersion: agent.runtimeVersion,
            status: 'SUCCEEDED'
          },
          createdAt: completed.toISOString()
        });
      });
      for (const activity of result.toolActivity.filter((value) => value.status === 'DENIED')) {
        await this.bestEffortObservabilityWrite(
          'policy_denial_audit_persistence_failed',
          async () => {
            await this.repository.appendAuditEvent({
              id: createAuditEventId(),
              tenantId: context.tenantId,
              actorId: context.userId,
              action: auditActions.POLICY_DENIED,
              resourceType: 'AGENT',
              resourceId: agent.id,
              metadata: {
                executionId,
                agentId: agent.id,
                tool: activity.tool,
                policyDecision: 'DENY'
              },
              createdAt: completed.toISOString()
            });
          }
        );
      }
      return success(
        playgroundInvokeResponseSchema.parse({
          result: result.result,
          toolActivity: result.toolActivity,
          sessionId: runtimeSessionId
        })
      );
    } catch (cause) {
      const error = runtimeInvocationApiError(cause);
      const completed = this.clock();
      await this.bestEffortObservabilityWrite(
        'failed_execution_summary_persistence_failed',
        async () => {
          await this.repository.createAgentExecutionSummary({
            executionId,
            tenantId: context.tenantId,
            agentId: agent.id,
            deploymentId: deployment.id,
            runtimeVersion: agent.runtimeVersion,
            endpointName: 'production',
            requestedBy: context.userId,
            status: 'FAILED',
            durationMs: Math.max(0, completed.getTime() - started.getTime()),
            toolActivity: [],
            policyDenialCount: 0,
            errorCode: error.code,
            startedAt: started.toISOString(),
            completedAt: completed.toISOString()
          });
        }
      );
      await this.bestEffortObservabilityWrite(
        'failed_invocation_audit_persistence_failed',
        async () => {
          await this.repository.appendAuditEvent({
            id: createAuditEventId(),
            tenantId: context.tenantId,
            actorId: context.userId,
            action: auditActions.AGENT_INVOCATION_FAILED,
            resourceType: 'AGENT',
            resourceId: agent.id,
            metadata: {
              executionId,
              deploymentId: deployment.id,
              runtimeVersion: agent.runtimeVersion,
              errorCode: error.code
            },
            createdAt: completed.toISOString()
          });
        }
      );
      throw error;
    }
  }

  private async executions(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    const agent = await this.agent(context, request);
    const listed = await this.repository.listAgentExecutionSummaries(
      context.tenantId,
      agent.id,
      options(request.queryParameters)
    );
    return success(listed.items, 200, listed);
  }

  private async metrics(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    const agent = await this.agent(context, request);
    const snapshot = await this.repository.getAgentMetricsSnapshot(context.tenantId, agent.id);
    if (!snapshot) return success({ availability: 'UNAVAILABLE' });
    const stale = this.clock().getTime() - Date.parse(snapshot.collectedAt) > 30 * 60 * 1000;
    return success(stale ? { ...snapshot, availability: 'STALE' as const } : snapshot);
  }

  private async auditEvents(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    const listed = await this.repository.listAuditEvents(
      context.tenantId,
      options(request.queryParameters)
    );
    return success(listed.items, 200, listed);
  }

  private async bestEffortObservabilityWrite(
    event: string,
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch (cause) {
      console.error(
        JSON.stringify({ event, errorName: cause instanceof Error ? cause.name : 'UnknownError' })
      );
    }
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
        action: auditActions.AGENT_CREATED,
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

  private async deployAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const agent = await this.agent(context, request);
    const key = normalizedIdempotencyKey(
      request.headers?.['idempotency-key'] ?? request.headers?.['Idempotency-Key']
    );
    const idempotencyKeyHash = hash(key);
    const existing = await this.repository.getDeploymentByIdempotency(
      context.tenantId,
      agent.id,
      idempotencyKeyHash
    );
    const artifact = (
      await this.repository.listAgentArtifacts(context.tenantId, { limit: 100 })
    ).items
      .filter(
        (value) =>
          value.agentId === agent.id &&
          value.configurationVersion === agent.revision &&
          value.status === 'READY'
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const requestHash = hash(
      JSON.stringify({
        tenantId: context.tenantId,
        agentId: agent.id,
        configurationRevision: agent.revision,
        artifactId: artifact?.id,
        artifactSha256: artifact?.sha256,
        target: agent.configuration.deploymentTarget
      })
    );
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was used for a different deployment request.'
        );
      const deployment = await this.repository.getDeployment(
        context.tenantId,
        existing.deploymentId
      );
      if (!deployment)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'The previous deployment request cannot be recovered.'
        );
      return success({ deploymentId: deployment.id, status: deployment.status }, 202);
    }
    const lock = await this.repository.getDeploymentLock(context.tenantId, agent.id);
    if (lock)
      throw new ApiError(
        409,
        'DEPLOYMENT_ALREADY_IN_PROGRESS',
        'A deployment is already in progress for this agent.'
      );
    const now = this.clock().toISOString();
    const deploymentId = createDeploymentId();
    const deployment = {
      id: deploymentId,
      tenantId: context.tenantId,
      agentId: agent.id,
      status: 'QUEUED' as const,
      stage: 'QUEUED' as const,
      requestedBy: context.userId,
      configurationRevision: agent.revision,
      snapshot: {
        templateId: agent.templateId,
        templateVersion: agent.templateVersion,
        ...(artifact ? { artifactId: artifact.id, artifactSha256: artifact.sha256 } : {}),
        awsConnectionId: agent.configuration.deploymentTarget.awsConnectionId,
        accountId: agent.configuration.deploymentTarget.accountId,
        region: agent.configuration.deploymentTarget.region,
        modelId: agent.configuration.model.modelId,
        capabilities: [...agent.configuration.capabilities],
        guardrails: agent.configuration.guardrails
      },
      idempotencyKeyHash,
      requestHash,
      createdAt: now
    };
    try {
      await this.repository.acquireDeploymentLock({
        tenantId: context.tenantId,
        agentId: agent.id,
        deploymentId,
        configurationRevision: agent.revision,
        acquiredAt: now
      });
    } catch (cause) {
      if (isConditional(cause))
        throw new ApiError(
          409,
          'DEPLOYMENT_ALREADY_IN_PROGRESS',
          'A deployment is already in progress for this agent.'
        );
      throw cause;
    }
    try {
      await this.repository.createDeploymentIdempotency({
        tenantId: context.tenantId,
        agentId: agent.id,
        idempotencyKeyHash,
        requestHash,
        deploymentId,
        createdAt: now
      });
      await this.repository.createDeployment(deployment);
      await this.repository.appendDeploymentEvent({
        id: createDeploymentEventId(),
        tenantId: context.tenantId,
        deploymentId,
        toStage: 'QUEUED',
        status: 'QUEUED',
        createdAt: now
      });
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: auditActions.DEPLOYMENT_REQUESTED,
        resourceType: 'DEPLOYMENT',
        resourceId: deploymentId,
        metadata: { agentId: agent.id, revision: agent.revision },
        createdAt: now
      });
      if (!this.workflowStarter)
        throw new ApiError(
          503,
          'DEPLOYMENT_UNAVAILABLE',
          'Deployment orchestration is not configured.'
        );
      const execution = await this.workflowStarter.start({
        deploymentId,
        tenantId: context.tenantId,
        agentId: agent.id,
        configurationRevision: agent.revision,
        ...(artifact ? { artifactId: artifact.id } : {})
      });
      await this.repository.setDeploymentExecutionArn(
        context.tenantId,
        deploymentId,
        execution.executionArn
      );
    } catch (cause) {
      // A deterministic execution name makes retries safe if StartExecution succeeded but the ARN write failed.
      if (cause instanceof ApiError && cause.code === 'DEPLOYMENT_UNAVAILABLE') {
        await this.repository
          .releaseDeploymentLock(context.tenantId, agent.id, deploymentId)
          .catch(() => undefined);
      }
      throw cause;
    }
    return success({ deploymentId, status: 'QUEUED' }, 202);
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
        action: auditActions.AGENT_CONFIGURATION_UPDATED,
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
