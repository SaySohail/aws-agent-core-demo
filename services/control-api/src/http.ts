import {
  agentIdSchema,
  agentTemplateIdSchema,
  awsConnectionIdSchema,
  createAgentId,
  createAgentRequestSchema,
  createAuditEventId,
  deploymentIdSchema,
  pageQuerySchema,
  tenantIdSchema,
  updateAgentRequestSchema,
  type Agent,
  type MembershipRole,
  type TenantContext
} from '@agent-launchpad/schemas';
import {
  ControlPlaneRepository,
  decodePageToken,
  type ListOptions,
  type Page
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
  readonly user?: AuthenticatedUser;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

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
    private readonly clock: () => Date = () => new Date()
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
    const listed = await this.repository.listAgentTemplates(options(request.queryParameters));
    return success(listed.items, 200, listed);
  }

  private async template(request: HttpRequest): Promise<HttpResponse> {
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
      return success(listed.items, 200, listed);
    }
    if (request.route === 'GET /tenants/{tenantId}/aws-connections/{connectionId}') {
      const connection = await this.repository.getAwsConnection(
        context.tenantId,
        parseAwsConnectionId(request.pathParameters?.connectionId)
      );
      if (!connection) throw new ApiError(404, 'NOT_FOUND', 'The AWS connection was not found.');
      return success(connection);
    }
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
    const template = await this.repository.getAgentTemplate(
      input.templateId,
      input.templateVersion
    );
    if (!template || template.status !== 'ACTIVE')
      throw new ApiError(404, 'NOT_FOUND', 'The agent template version was not found.');
    const now = this.clock().toISOString();
    const agent: Agent = {
      id: createAgentId(),
      tenantId: context.tenantId,
      ...input,
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
        createdAt: now
      });
    } catch (cause) {
      asConflict(cause);
    }
    return success(agent, 201);
  }

  private async updateAgent(context: TenantContext, request: HttpRequest): Promise<HttpResponse> {
    requireRole(context, 'ADMIN');
    const agent = await this.agent(context, request);
    const changes = parse(updateAgentRequestSchema, body(request));
    const updatedAt = this.clock().toISOString();
    try {
      await this.repository.updateAgent(context, agent.id, {
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.model !== undefined ? { model: changes.model } : {}),
        ...(changes.region !== undefined ? { region: changes.region } : {}),
        updatedAt
      });
      await this.repository.appendAuditEvent({
        id: createAuditEventId(),
        tenantId: context.tenantId,
        actorId: context.userId,
        action: 'AGENT_UPDATED',
        resourceType: 'AGENT',
        resourceId: agent.id,
        createdAt: updatedAt
      });
    } catch (cause) {
      asConflict(cause);
    }
    return success({ ...agent, ...changes, updatedAt });
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
