import assert from 'node:assert/strict';
import test from 'node:test';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import {
  AgentCoreSecurityError,
  AgentRuntimeInvoker,
  runtimeInboundAuthentication,
  validateAgentCoreMetadata,
  validateGatewayArn,
  validateRuntimeArn,
  validateWorkloadIdentityArn
} from './agentcore-security.js';

const coordinates = { accountId: '123456789012', region: 'us-east-1' };
const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/support-agent';
const gatewayArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gateway-123';
const identityArn =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:workload-identity-directory/directory-123/workload-identity/runtime-identity';

test('validates AgentCore resource and workload-identity coordinates', () => {
  assert.equal(validateRuntimeArn(runtimeArn, coordinates), runtimeArn);
  assert.equal(validateGatewayArn(gatewayArn, coordinates), gatewayArn);
  assert.equal(validateWorkloadIdentityArn(identityArn, coordinates), identityArn);
  validateAgentCoreMetadata({
    connection: coordinates,
    runtimeArn,
    gatewayArn,
    runtimeWorkloadIdentityArn: identityArn,
    gatewayWorkloadIdentityArn: identityArn
  });
});

for (const [name, value, validate, code] of [
  [
    'wrong account',
    'arn:aws:bedrock-agentcore:us-east-1:999999999999:runtime/support-agent',
    validateRuntimeArn,
    'INVALID_RUNTIME_ARN'
  ],
  [
    'wrong region',
    'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-123',
    validateGatewayArn,
    'INVALID_GATEWAY_ARN'
  ],
  [
    'malformed identity',
    'arn:aws:iam::123456789012:role/not-an-agentcore-identity',
    validateWorkloadIdentityArn,
    'WORKLOAD_IDENTITY_MISMATCH'
  ]
] as const) {
  test(`rejects ${name} AgentCore metadata`, () => {
    assert.throws(
      () => validate(value, coordinates),
      (error: unknown) => error instanceof AgentCoreSecurityError && error.code === code
    );
  });
}

test('invoker uses only caller-supplied temporary credentials and the official data-plane command', async () => {
  const credentials = {
    accessKeyId: 'ASIAEXAMPLE',
    secretAccessKey: 'secret',
    sessionToken: 'token'
  };
  let config: unknown;
  let command: unknown;
  const invoker = new AgentRuntimeInvoker((input) => {
    config = input;
    return {
      async send(value) {
        command = value;
        return { response: { transformToString: async () => '{"result":"ok"}' } };
      }
    };
  });
  const result = await invoker.invoke({
    runtimeArn,
    payload: { prompt: 'hello' },
    sessionId: 'session-1',
    credentials,
    connection: coordinates
  });
  assert.equal(result, '{"result":"ok"}');
  assert.deepEqual(config, { region: 'us-east-1', credentials });
  assert.ok(command instanceof InvokeAgentRuntimeCommand);
  assert.equal((command as InvokeAgentRuntimeCommand).input.agentRuntimeArn, runtimeArn);
  assert.equal((command as InvokeAgentRuntimeCommand).input.runtimeSessionId, 'session-1');
});

test('runtime inbound contract is IAM SigV4 with no browser or user-delegation path', () => {
  assert.deepEqual(runtimeInboundAuthentication, {
    mode: 'AWS_IAM_SIGV4',
    directBrowserInvocation: false,
    userIdDelegation: false
  });
});
