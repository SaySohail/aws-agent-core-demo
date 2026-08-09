import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCoreClientToken,
  agentCoreRuntimeName,
  PRODUCTION_RUNTIME_ENDPOINT,
  runtimeMetadataConfiguration,
  runtimeNetworkConfiguration,
  runtimeInvocationPolicy
} from './agentcore-runtime.js';

test('runtime name is stable and derives only from the immutable agent id', () => {
  const agentId = 'agt_00000000-0000-4000-8000-000000000001';
  assert.equal(agentCoreRuntimeName(agentId), agentCoreRuntimeName(agentId));
  assert.match(agentCoreRuntimeName(agentId), /^agent-launchpad-[a-z0-9-]+$/);
  assert.match(agentCoreRuntimeName(agentId), /-[a-f0-9]{12}$/);
  assert.notEqual(
    agentCoreRuntimeName(agentId),
    agentCoreRuntimeName('agt_00000000-0000-4000-8000-000000000002')
  );
});

test('customer invocation role receives a resource policy only for the exact Runtime', () => {
  const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123';
  const policy = JSON.parse(runtimeInvocationPolicy(runtimeArn, '123456789012'));
  assert.deepEqual(policy.Statement[0], {
    Effect: 'Allow',
    Principal: { AWS: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole' },
    Action: 'bedrock-agentcore:InvokeAgentRuntime',
    Resource: runtimeArn
  });
  assert.ok(!JSON.stringify(policy).includes('*'));
});

test('client tokens are deterministic, operation-scoped, and production endpoint is stable', () => {
  const input = {
    deploymentId: 'dep_00000000-0000-4000-8000-000000000001',
    operation: 'update' as const,
    artifactSha256: 'a'.repeat(64)
  };
  assert.equal(agentCoreClientToken(input), agentCoreClientToken(input));
  assert.notEqual(
    agentCoreClientToken(input),
    agentCoreClientToken({ ...input, operation: 'create' })
  );
  assert.match(agentCoreClientToken(input), /^al-update-[a-f0-9]{64}$/);
  assert.equal(PRODUCTION_RUNTIME_ENDPOINT, 'production');
  assert.deepEqual(runtimeMetadataConfiguration, { requireMMDSV2: true });
  // PUBLIC makes the demo Runtime network reachable, but caller IAM/SigV4 remains mandatory.
  assert.deepEqual(runtimeNetworkConfiguration, { networkMode: 'PUBLIC' });
});
