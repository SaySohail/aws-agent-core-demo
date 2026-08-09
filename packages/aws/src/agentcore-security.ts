import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand
} from '@aws-sdk/client-bedrock-agentcore';
import {
  runtimeResponseSchema,
  type AwsConnection,
  type RuntimeResponse
} from '@agent-launchpad/schemas';
import type { AssumedCustomerRoleCredentials } from './customer-connection.js';

const ARN = /^arn:(aws):([a-z0-9-]+):([a-z0-9-]+):(\d{12}):(.*)$/;
const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

export type AgentCoreSecurityErrorCode =
  | 'INVALID_RUNTIME_ARN'
  | 'INVALID_GATEWAY_ARN'
  | 'WORKLOAD_IDENTITY_MISMATCH'
  | 'RUNTIME_UNAUTHENTICATED'
  | 'RUNTIME_FORBIDDEN'
  | 'RUNTIME_IDENTITY_MISMATCH';

/** Safe server-facing error: the underlying AWS exception is deliberately not exposed. */
export class AgentCoreSecurityError extends Error {
  public constructor(public readonly code: AgentCoreSecurityErrorCode) {
    super(code);
  }
}

export type RuntimeInvocationErrorCode =
  | 'RUNTIME_INVALID_REQUEST'
  | 'RUNTIME_QUOTA_EXCEEDED'
  | 'RUNTIME_FORBIDDEN'
  | 'RUNTIME_NOT_FOUND'
  | 'RUNTIME_CONFLICT'
  | 'RUNTIME_CLIENT_ERROR'
  | 'RUNTIME_THROTTLED'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_TIMEOUT'
  | 'INVALID_RUNTIME_RESPONSE'
  | 'RUNTIME_RESPONSE_TOO_LARGE';

export class RuntimeInvocationError extends Error {
  public constructor(public readonly code: RuntimeInvocationErrorCode) {
    super(code);
  }
}

export const MAX_RUNTIME_RESPONSE_BYTES = 256 * 1024;

export interface AgentCoreResourceCoordinates {
  readonly accountId: string;
  readonly region: string;
  readonly partition?: 'aws';
}

interface ParsedAgentCoreArn extends Required<AgentCoreResourceCoordinates> {
  readonly resource: string;
}

function parseAgentCoreArn(
  value: string,
  coordinates: AgentCoreResourceCoordinates
): ParsedAgentCoreArn {
  const matched = ARN.exec(value);
  if (!matched || matched[2] !== 'bedrock-agentcore' || !regionPattern.test(matched[3] ?? ''))
    throw new AgentCoreSecurityError('WORKLOAD_IDENTITY_MISMATCH');
  const [, partition, , region, accountId, resource] = matched;
  if (
    partition !== (coordinates.partition ?? 'aws') ||
    accountId !== coordinates.accountId ||
    region !== coordinates.region
  )
    throw new AgentCoreSecurityError('WORKLOAD_IDENTITY_MISMATCH');
  return { partition: 'aws', accountId: accountId!, region: region!, resource: resource! };
}

export function validateRuntimeArn(
  value: string,
  coordinates: AgentCoreResourceCoordinates
): string {
  try {
    const parsed = parseAgentCoreArn(value, coordinates);
    if (!/^runtime\/[^/]+$/.test(parsed.resource)) throw new Error('Not a runtime ARN.');
    return value;
  } catch {
    throw new AgentCoreSecurityError('INVALID_RUNTIME_ARN');
  }
}

export function validateGatewayArn(
  value: string,
  coordinates: AgentCoreResourceCoordinates
): string {
  try {
    const parsed = parseAgentCoreArn(value, coordinates);
    if (!/^gateway\/[^/]+$/.test(parsed.resource)) throw new Error('Not a gateway ARN.');
    return value;
  } catch {
    throw new AgentCoreSecurityError('INVALID_GATEWAY_ARN');
  }
}

/** Validates a trusted GetGateway/CloudFormation response as one coherent Gateway identity. */
export function validateGatewayMetadata(input: {
  readonly connection: Pick<AwsConnection, 'accountId' | 'region'>;
  readonly gatewayId: string;
  readonly gatewayArn: string;
  readonly workloadIdentityArn: string;
}): void {
  const gatewayArn = validateGatewayArn(input.gatewayArn, input.connection);
  if (!gatewayArn.endsWith(`gateway/${input.gatewayId}`))
    throw new AgentCoreSecurityError('INVALID_GATEWAY_ARN');
  validateWorkloadIdentityArn(input.workloadIdentityArn, input.connection);
}

export function validateWorkloadIdentityArn(
  value: string,
  coordinates: AgentCoreResourceCoordinates
): string {
  const parsed = parseAgentCoreArn(value, coordinates);
  if (!/^workload-identity-directory\/[^/]+\/workload-identity\/[^/]+$/.test(parsed.resource))
    throw new AgentCoreSecurityError('WORKLOAD_IDENTITY_MISMATCH');
  return value;
}

export function validateAgentCoreMetadata(input: {
  readonly connection: Pick<AwsConnection, 'accountId' | 'region'>;
  readonly runtimeArn?: string;
  readonly gatewayArn?: string;
  readonly runtimeWorkloadIdentityArn?: string;
  readonly gatewayWorkloadIdentityArn?: string;
}): void {
  const coordinates = input.connection;
  if (input.runtimeArn) validateRuntimeArn(input.runtimeArn, coordinates);
  if (input.gatewayArn) validateGatewayArn(input.gatewayArn, coordinates);
  if (input.runtimeWorkloadIdentityArn)
    validateWorkloadIdentityArn(input.runtimeWorkloadIdentityArn, coordinates);
  if (input.gatewayWorkloadIdentityArn)
    validateWorkloadIdentityArn(input.gatewayWorkloadIdentityArn, coordinates);
}

/**
 * SAY-100 must consume this explicit contract. AgentCore's IAM behavior is the deliberate
 * production default; public, browser, JWT, and user-delegation Runtime paths are prohibited.
 */
export const runtimeInboundAuthentication = {
  mode: 'AWS_IAM_SIGV4',
  directBrowserInvocation: false,
  userIdDelegation: false
} as const;

export interface AgentRuntimeInvocationClient {
  invoke(input: {
    readonly runtimeArn: string;
    readonly payload: unknown;
    readonly sessionId?: string;
    readonly qualifier?: string;
    readonly credentials: AssumedCustomerRoleCredentials;
    readonly connection: Pick<AwsConnection, 'accountId' | 'region'>;
  }): Promise<RuntimeResponse & { readonly traceId?: string; readonly runtimeSessionId?: string }>;
}

interface RuntimeDataPlaneClient {
  send(
    command: InvokeAgentRuntimeCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<{
    response?: unknown;
    contentType?: string;
    traceId?: string;
    runtimeSessionId?: string;
  }>;
}

/** Server-only AgentCore data-plane client. Callers supply fresh STS credentials per operation. */
export class AgentRuntimeInvoker implements AgentRuntimeInvocationClient {
  public constructor(
    private readonly createClient: (input: {
      readonly region: string;
      readonly credentials: AssumedCustomerRoleCredentials;
    }) => RuntimeDataPlaneClient = (input) =>
      new BedrockAgentCoreClient({ ...input, maxAttempts: 1 })
  ) {}

  public async invoke(input: {
    readonly runtimeArn: string;
    readonly payload: unknown;
    readonly sessionId?: string;
    readonly qualifier?: string;
    readonly credentials: AssumedCustomerRoleCredentials;
    readonly connection: Pick<AwsConnection, 'accountId' | 'region'>;
    readonly timeoutMs?: number;
  }): Promise<RuntimeResponse> {
    validateRuntimeArn(input.runtimeArn, input.connection);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
    try {
      const client = this.createClient({
        region: input.connection.region,
        credentials: input.credentials
      });
      const response = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: input.runtimeArn,
          runtimeSessionId: input.sessionId ?? crypto.randomUUID(),
          payload: JSON.stringify(input.payload),
          contentType: 'application/json',
          accept: 'application/json',
          qualifier: input.qualifier ?? 'production'
        }),
        { abortSignal: controller.signal }
      );
      if (
        response.contentType &&
        response.contentType.split(';', 1)[0]?.toLowerCase() !== 'application/json'
      )
        throw new RuntimeInvocationError('INVALID_RUNTIME_RESPONSE');
      const text = await readRuntimeResponse(response.response, MAX_RUNTIME_RESPONSE_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RuntimeInvocationError('INVALID_RUNTIME_RESPONSE');
      }
      const validated = runtimeResponseSchema.safeParse(parsed);
      if (!validated.success) throw new RuntimeInvocationError('INVALID_RUNTIME_RESPONSE');
      // AgentCore returns tracing identifiers as operational correlation metadata. They are
      // retained server-side by callers and are deliberately not part of the runtime payload.
      return {
        ...validated.data,
        ...(safeCorrelationId(response.traceId) ? { traceId: response.traceId } : {}),
        ...(safeCorrelationId(response.runtimeSessionId)
          ? { runtimeSessionId: response.runtimeSessionId }
          : {})
      };
    } catch (cause) {
      if (cause instanceof RuntimeInvocationError) throw cause;
      if (controller.signal.aborted) throw new RuntimeInvocationError('RUNTIME_TIMEOUT');
      const name = cause instanceof Error ? cause.name : '';
      if (/AccessDenied|Forbidden/.test(name))
        throw new AgentCoreSecurityError('RUNTIME_FORBIDDEN');
      if (/UnrecognizedClient|InvalidSignature|Unauthorized/.test(name))
        throw new AgentCoreSecurityError('RUNTIME_UNAUTHENTICATED');
      throw mapRuntimeInvocationError(name);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

export async function readRuntimeResponse(
  body: unknown,
  maximumBytes = MAX_RUNTIME_RESPONSE_BYTES
): Promise<string> {
  if (!body) return '';
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      const bytes =
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > maximumBytes) throw new RuntimeInvocationError('RUNTIME_RESPONSE_TOO_LARGE');
      chunks.push(bytes);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(concatenate(chunks, total));
  }
  if (typeof body === 'object' && body !== null && 'transformToString' in body) {
    const text = await (body as { transformToString(): Promise<string> }).transformToString();
    if (Buffer.byteLength(text, 'utf8') > maximumBytes)
      throw new RuntimeInvocationError('RUNTIME_RESPONSE_TOO_LARGE');
    return text;
  }
  throw new RuntimeInvocationError('INVALID_RUNTIME_RESPONSE');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function concatenate(chunks: Uint8Array[], total: number): Uint8Array {
  const value = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function mapRuntimeInvocationError(name: string): RuntimeInvocationError {
  const code: RuntimeInvocationErrorCode = /ValidationException/.test(name)
    ? 'RUNTIME_INVALID_REQUEST'
    : /ServiceQuotaExceeded/.test(name)
      ? 'RUNTIME_QUOTA_EXCEEDED'
      : /ResourceNotFound/.test(name)
        ? 'RUNTIME_NOT_FOUND'
        : /RetryableConflict/.test(name)
          ? 'RUNTIME_CONFLICT'
          : /RuntimeClientError/.test(name)
            ? 'RUNTIME_CLIENT_ERROR'
            : /Throttling/.test(name)
              ? 'RUNTIME_THROTTLED'
              : 'RUNTIME_UNAVAILABLE';
  return new RuntimeInvocationError(code);
}
