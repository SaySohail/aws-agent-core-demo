/* eslint-disable @typescript-eslint/no-explicit-any -- focused boundary test doubles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DeploymentWorker } from './index.js';

const deployment = (operationType: 'DEPLOY' | 'ROLLBACK' | 'UNDEPLOY') =>
  ({
    id: 'dep_00000000-0000-4000-8000-000000000001',
    tenantId: 'ten_00000000-0000-4000-8000-000000000001',
    agentId: 'agt_00000000-0000-4000-8000-000000000001',
    operationType,
    status: 'QUEUED',
    stage: 'QUEUED',
    requestedBy: 'usr_00000000-0000-4000-8000-000000000001',
    configurationRevision: 1,
    snapshot: {},
    idempotencyKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as any;

const workerFor = (operationType: 'DEPLOY' | 'ROLLBACK' | 'UNDEPLOY', calls: string[]) =>
  new DeploymentWorker({
    repository: {
      getDeployment: async () => deployment(operationType),
      recordDeploymentStage: async () => undefined,
      releaseDeploymentLock: async () => undefined
    } as any,
    runtime: {
      validateRollbackTarget: async () => {
        calls.push('verify-target');
        return 'READY' as const;
      },
      rollbackProductionEndpoint: async () => {
        calls.push('update-endpoint');
        return 'PENDING' as const;
      },
      getRollbackStatus: async () => 'READY' as const,
      checkRollbackHealth: async () => 'READY' as const,
      revertRollbackEndpoint: async () => {
        calls.push('revert-endpoint');
        return 'READY' as const;
      }
    } as any,
    undeployRuntime: {} as any,
    dependencies: {} as any,
    artifactPipeline: {} as any,
    customerRoleAssumer: {} as any,
    bedrock: {} as any,
    agentCore: {} as any
  });

const input = (operationType: 'DEPLOY' | 'ROLLBACK' | 'UNDEPLOY') => ({
  deploymentId: 'dep_00000000-0000-4000-8000-000000000001',
  tenantId: 'ten_00000000-0000-4000-8000-000000000001',
  agentId: 'agt_00000000-0000-4000-8000-000000000001',
  configurationRevision: 1,
  operationType
});

test('rollback reaches only its explicit rollback stage handler', async () => {
  const calls: string[] = [];
  const worker = workerFor('ROLLBACK', calls);
  await worker.dispatch('ROLLBACK_VERIFYING_TARGET', input('ROLLBACK'));
  assert.deepEqual(calls, ['verify-target']);
});

test('undeploy and unknown operations do not fall through to deploy', async () => {
  const calls: string[] = [];
  await workerFor('UNDEPLOY', calls).dispatch('UNDEPLOY_VALIDATING', input('UNDEPLOY'));
  await assert.rejects(
    workerFor('DEPLOY', calls).dispatch('ROLLBACK_VERIFYING_TARGET', input('DEPLOY')),
    /Terminal stages are not worker commands/
  );
  await assert.rejects(
    workerFor('DEPLOY', calls).dispatch('VALIDATING', {
      ...input('DEPLOY'),
      operationType: 'UNKNOWN'
    } as any),
    /Lifecycle task operation does not match/
  );
});
