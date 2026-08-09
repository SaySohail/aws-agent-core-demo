import assert from 'node:assert/strict';
import test from 'node:test';
import type { AwsConnection, Deployment } from '@agent-launchpad/schemas';
import { ListAgentRuntimesCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import {
  AgentCoreControlPlanePreflightChecker,
  agentCorePreflightError
} from './agentcore-preflight.js';

const tenantId = 'tnt_00000000-0000-4000-8000-000000000001';
const deployment = {
  id: 'dep_00000000-0000-4000-8000-000000000001',
  tenantId,
  agentId: 'agt_00000000-0000-4000-8000-000000000001',
  status: 'QUEUED',
  stage: 'PREFLIGHT_AGENTCORE',
  requestedBy: 'user',
  configurationRevision: 1,
  snapshot: {
    templateId: 'customer-support',
    templateVersion: '1',
    awsConnectionId: 'awc_00000000-0000-4000-8000-000000000001',
    accountId: '123456789012',
    region: 'us-east-1',
    modelId: 'amazon.nova-lite-v1:0',
    capabilities: ['ORDER_LOOKUP'],
    guardrails: { refunds: { enabled: false } }
  },
  idempotencyKeyHash: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z'
} as Deployment;
const connection = {
  id: deployment.snapshot.awsConnectionId,
  tenantId,
  accountId: '123456789012',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole',
  externalId: 'external',
  status: 'VERIFIED',
  createdBy: 'user',
  createdAt: deployment.createdAt,
  updatedAt: deployment.createdAt
} as AwsConnection;

test('AgentCore preflight uses assumed customer credentials, target Region, and a read-only list call', async () => {
  const credentials = { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token' };
  let clientInput: unknown;
  let command: unknown;
  const checker = new AgentCoreControlPlanePreflightChecker(
    { getAwsConnection: async () => connection } as never,
    { assumeCustomerRole: async () => credentials } as never,
    (input) =>
      ({
        send: async (value: unknown) => {
          clientInput = input;
          command = value;
          return {};
        }
      }) as never
  );
  await checker.check(deployment);
  assert.deepEqual(clientInput, { region: 'us-east-1', credentials });
  assert.ok(command instanceof ListAgentRuntimesCommand);
  assert.deepEqual((command as ListAgentRuntimesCommand).input, { maxResults: 1 });
});

test('AgentCore preflight classifies customer-visible failures', () => {
  const cases = [
    ['AccessDeniedException', undefined, 'AGENTCORE_ACCESS_DENIED', false],
    ['UnknownEndpoint', undefined, 'AGENTCORE_REGION_UNAVAILABLE', false],
    ['ValidationException', undefined, 'AGENTCORE_PERMISSION_CONFIGURATION_INVALID', false],
    ['ThrottlingException', 503, 'AGENTCORE_PREFLIGHT_TRANSIENT_FAILURE', true]
  ] as const;
  for (const [name, httpStatusCode, code, retryable] of cases) {
    const error = agentCorePreflightError({
      name,
      $metadata: { httpStatusCode, requestId: 'req-1' }
    });
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal(error.serviceRequestId, 'req-1');
  }
});
