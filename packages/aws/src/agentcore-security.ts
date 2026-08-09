import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand
} from '@aws-sdk/client-bedrock-agentcore';
import type { AwsConnection } from '@agent-launchpad/schemas';
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
  }): Promise<string>;
}

interface RuntimeDataPlaneClient {
  send(command: InvokeAgentRuntimeCommand): Promise<{
    response?: { transformToString(): Promise<string> };
  }>;
}

/** Server-only AgentCore data-plane client. Callers supply fresh STS credentials per operation. */
export class AgentRuntimeInvoker implements AgentRuntimeInvocationClient {
  public constructor(
    private readonly createClient: (input: {
      readonly region: string;
      readonly credentials: AssumedCustomerRoleCredentials;
    }) => RuntimeDataPlaneClient = (input) => new BedrockAgentCoreClient(input)
  ) {}

  public async invoke(input: {
    readonly runtimeArn: string;
    readonly payload: unknown;
    readonly sessionId?: string;
    readonly qualifier?: string;
    readonly credentials: AssumedCustomerRoleCredentials;
    readonly connection: Pick<AwsConnection, 'accountId' | 'region'>;
  }): Promise<string> {
    validateRuntimeArn(input.runtimeArn, input.connection);
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
          qualifier: input.qualifier ?? 'DEFAULT'
        })
      );
      return (await response.response?.transformToString()) ?? '';
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : '';
      if (/AccessDenied|Forbidden/.test(name))
        throw new AgentCoreSecurityError('RUNTIME_FORBIDDEN');
      if (/UnrecognizedClient|InvalidSignature|Unauthorized/.test(name))
        throw new AgentCoreSecurityError('RUNTIME_UNAUTHENTICATED');
      throw cause;
    }
  }
}
