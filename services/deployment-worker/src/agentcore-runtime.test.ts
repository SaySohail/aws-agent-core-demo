import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCoreClientToken,
  agentCoreRuntimeName,
  PRODUCTION_RUNTIME_ENDPOINT,
  runtimeMetadataConfiguration
} from './agentcore-runtime.js';

test('runtime name is stable and derives only from the immutable agent id', () => {
  const agentId = 'agt_00000000-0000-4000-8000-000000000001';
  assert.equal(agentCoreRuntimeName(agentId), agentCoreRuntimeName(agentId));
  assert.match(agentCoreRuntimeName(agentId), /^agent-launchpad-[a-z0-9-]+$/);
  assert.equal(
    agentCoreRuntimeName(agentId),
    'agent-launchpad-agt-00000000-0000-4000-8000-000000000001'
  );
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
});
