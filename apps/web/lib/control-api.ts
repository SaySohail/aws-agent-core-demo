import type {
  Agent,
  AgentTemplate,
  AwsConnection,
  CreateAwsConnectionRequest as SharedCreateAwsConnectionRequest,
  CreateAgentRequest as SharedCreateAgentRequest,
  Deployment,
  DeploymentDetail,
  PlaygroundInvokeRequest,
  PlaygroundInvokeResponse,
  MembershipRole,
  Tenant,
  UpdateAgentRequest as SharedUpdateAgentRequest
} from '@agent-launchpad/schemas';

export type ApiErrorCode = string;

export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly requestId: string;
}

export class ControlApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody
  ) {
    super(body.message);
    this.name = 'ControlApiError';
  }
}

export interface PageQuery {
  readonly pageSize?: number;
  readonly nextToken?: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page?: {
    readonly nextToken?: string;
  };
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly email?: string;
}

export interface TenantMembershipSummary {
  readonly tenantId: string;
  readonly role: MembershipRole;
}

export interface MeResponse {
  readonly user: AuthenticatedUser;
  readonly tenants: readonly TenantMembershipSummary[];
}

export type TenantSummary = Tenant & {
  readonly role: MembershipRole;
};

/** Strict mutation inputs shared with the API boundary; server-owned fields are excluded. */
export type CreateAgentRequest = SharedCreateAgentRequest;
export type UpdateAgentRequest = SharedUpdateAgentRequest;
export type CreateAwsConnectionRequest = SharedCreateAwsConnectionRequest;
export type AwsConnectionOnboarding = Omit<AwsConnection, 'externalId'> & {
  readonly quickCreateUrl: string;
};

export interface ControlApiClientOptions {
  /** Control-plane API origin, for example https://api.example.com. */
  readonly baseUrl: string;
  /** Supplies the Cognito JWT at request time; the client never persists it. */
  readonly getAccessToken: () => Promise<string | null> | string | null;
  readonly fetch?: typeof fetch;
}

interface SuccessEnvelope<T> {
  readonly data: T;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * Browser/server-neutral typed client for the authenticated control-plane API.
 * Keep all URL construction and bearer-token attachment here, outside React components.
 */
export function createControlApiClient(options: ControlApiClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? fetch;

  const request = async <T>(path: string, requestOptions: RequestOptions = {}): Promise<T> => {
    const token = await options.getAccessToken();
    const response = await fetchImplementation(new URL(path, baseUrl), {
      method: requestOptions.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...requestOptions.headers,
        ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) })
    });
    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw new ControlApiError(response.status, errorBody(payload, response));
    }
    if (!isSuccessEnvelope(payload)) {
      throw new ControlApiError(response.status, {
        code: 'INTERNAL_ERROR',
        message: 'The control-plane API returned an invalid response.',
        requestId: response.headers.get('x-amzn-requestid') ?? 'unknown'
      });
    }
    return payload.data as T;
  };

  const requestPage = async <T>(path: string): Promise<Page<T>> => {
    const token = await options.getAccessToken();
    const response = await fetchImplementation(new URL(path, baseUrl), {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new ControlApiError(response.status, errorBody(payload, response));
    if (!isSuccessEnvelope(payload) || !Array.isArray(payload.data)) {
      throw new ControlApiError(response.status, {
        code: 'INTERNAL_ERROR',
        message: 'The control-plane API returned an invalid response.',
        requestId: response.headers.get('x-amzn-requestid') ?? 'unknown'
      });
    }
    const page =
      'page' in payload &&
      typeof payload.page === 'object' &&
      payload.page !== null &&
      (typeof (payload.page as { nextToken?: unknown }).nextToken === 'string' ||
        !('nextToken' in payload.page))
        ? (payload.page as Page<T>['page'])
        : undefined;
    return { data: payload.data as readonly T[], ...(page ? { page } : {}) };
  };

  return {
    me: {
      get: () => request<MeResponse>('/me')
    },
    tenants: {
      list: (query?: PageQuery) => requestPage<TenantSummary>(`/tenants${queryString(query)}`),
      get: (tenantId: string) => request<Tenant>(`/tenants/${segment(tenantId)}`)
    },
    agentTemplates: {
      list: (query?: PageQuery) =>
        requestPage<AgentTemplate>(`/agent-templates${queryString(query)}`),
      get: (templateId: string, version: string) =>
        request<AgentTemplate>(
          `/agent-templates/${segment(templateId)}/versions/${segment(version)}`
        )
    },
    agents: {
      list: (tenantId: string, query?: PageQuery) =>
        requestPage<Agent>(`/tenants/${segment(tenantId)}/agents${queryString(query)}`),
      get: (tenantId: string, agentId: string) =>
        request<Agent>(`/tenants/${segment(tenantId)}/agents/${segment(agentId)}`),
      create: (tenantId: string, input: CreateAgentRequest) =>
        request<Agent>(`/tenants/${segment(tenantId)}/agents`, { method: 'POST', body: input }),
      update: (tenantId: string, agentId: string, input: UpdateAgentRequest) =>
        request<Agent>(`/tenants/${segment(tenantId)}/agents/${segment(agentId)}`, {
          method: 'PATCH',
          body: input
        }),
      invoke: (tenantId: string, agentId: string, input: PlaygroundInvokeRequest) =>
        request<PlaygroundInvokeResponse>(
          `/tenants/${segment(tenantId)}/agents/${segment(agentId)}/invoke`,
          { method: 'POST', body: input }
        )
    },
    awsConnections: {
      list: (tenantId: string, query?: PageQuery) =>
        requestPage<AwsConnectionOnboarding>(
          `/tenants/${segment(tenantId)}/aws-connections${queryString(query)}`
        ),
      get: (tenantId: string, connectionId: string) =>
        request<AwsConnectionOnboarding>(
          `/tenants/${segment(tenantId)}/aws-connections/${segment(connectionId)}`
        ),
      create: (tenantId: string, input: CreateAwsConnectionRequest) =>
        request<AwsConnectionOnboarding>(`/tenants/${segment(tenantId)}/aws-connections`, {
          method: 'POST',
          body: input
        }),
      verify: (tenantId: string, connectionId: string) =>
        request<AwsConnectionOnboarding>(
          `/tenants/${segment(tenantId)}/aws-connections/${segment(connectionId)}/verify`,
          { method: 'POST', body: {} }
        )
    },
    deployments: {
      list: (tenantId: string, query?: PageQuery) =>
        requestPage<Deployment>(`/tenants/${segment(tenantId)}/deployments${queryString(query)}`),
      get: (tenantId: string, deploymentId: string) =>
        request<DeploymentDetail>(
          `/tenants/${segment(tenantId)}/deployments/${segment(deploymentId)}`
        ),
      retry: (tenantId: string, deploymentId: string, idempotencyKey: string) =>
        request<{ deploymentId: string; status: Deployment['status'] }>(
          `/tenants/${segment(tenantId)}/deployments/${segment(deploymentId)}/retry`,
          { method: 'POST', body: {}, headers: { 'idempotency-key': idempotencyKey } }
        ),
      listForAgent: (tenantId: string, agentId: string, query?: PageQuery) =>
        requestPage<Deployment>(
          `/tenants/${segment(tenantId)}/agents/${segment(agentId)}/deployments${queryString(query)}`
        )
    }
  };
}

export type ControlApiClient = ReturnType<typeof createControlApiClient>;

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.search || url.hash)
    throw new Error('Control API base URL cannot include a query or fragment.');
  return new URL(`${url.toString().replace(/\/$/, '')}/`);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function queryString(query: PageQuery | undefined): string {
  if (!query) return '';
  const parameters = new URLSearchParams();
  if (query.pageSize !== undefined) parameters.set('pageSize', String(query.pageSize));
  if (query.nextToken !== undefined) parameters.set('nextToken', query.nextToken);
  const value = parameters.toString();
  return value ? `?${value}` : '';
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'data' in value;
}

function errorBody(value: unknown, response: Response): ApiErrorBody {
  const candidate =
    typeof value === 'object' && value !== null && 'error' in value ? value.error : value;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'code' in candidate &&
    'message' in candidate &&
    'requestId' in candidate &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.requestId === 'string'
  ) {
    return candidate as ApiErrorBody;
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'The control-plane API request failed.',
    requestId: response.headers.get('x-amzn-requestid') ?? 'unknown'
  };
}
