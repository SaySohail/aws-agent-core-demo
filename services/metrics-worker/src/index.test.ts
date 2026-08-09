import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, AwsConnection } from '@agent-launchpad/schemas';
import { MetricsWorker, type AgentCoreMetricsReader } from './index.js';

const now = new Date('2026-01-01T00:15:00.000Z');
const agent = (id: string): Agent => ({
  id,
  tenantId: 'tnt_00000000-0000-4000-8000-000000000001',
  templateId: 'tpl_00000000-0000-4000-8000-000000000001', templateVersion: '1', name: 'Support',
  model: 'amazon.nova-lite-v1:0', region: 'us-east-1', revision: 1, status: 'ACTIVE', runtimeId: 'runtime-1',
  configuration: { configurationVersion: 1, template: { id: 'tpl_00000000-0000-4000-8000-000000000001', version: '1' }, name: 'Support', deploymentTarget: { awsConnectionId: 'awc_00000000-0000-4000-8000-000000000001', accountId: '123456789012', region: 'us-east-1' }, model: { modelId: 'amazon.nova-lite-v1:0' }, capabilities: ['ORDER_LOOKUP'], guardrails: { refunds: { enabled: false } } },
  createdAt: now.toISOString(), updatedAt: now.toISOString()
});
const connection: AwsConnection = { id: 'awc_00000000-0000-4000-8000-000000000001', tenantId: agent('agt_00000000-0000-4000-8000-000000000001').tenantId, accountId: '123456789012', region: 'us-east-1', roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole', externalId: 'secret-not-persisted', status: 'VERIFIED', createdBy: 'system', createdAt: now.toISOString(), updatedAt: now.toISOString() };

test('collects normalized metrics and isolates an agent failure', async () => {
  const writes: unknown[] = [];
  const agents = [agent('agt_00000000-0000-4000-8000-000000000001'), agent('agt_00000000-0000-4000-8000-000000000002')];
  const repository = {
    listActiveDeployedAgents: async () => ({ items: agents, nextToken: undefined }),
    getAwsConnection: async () => connection,
    putAgentMetricsSnapshot: async (value: unknown) => { writes.push(value); },
    getAgent: async () => agent('agt_00000000-0000-4000-8000-000000000001')
  };
  const reader: AgentCoreMetricsReader = { read: async ({ agent: item }) => {
    if (item.id.endsWith('2')) throw new Error('AccessDenied');
    return { invocationCount: 4, errorCount: 1, throttleCount: 0, latencyAverageMs: 10, latencyP95Ms: 18 };
  } };
  const worker = new MetricsWorker({ repository: repository as never, assumer: { assumeCustomerRole: async () => ({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' }) } as never, reader, now: () => now });
  assert.deepEqual(await worker.collectAll(), { collected: 1, failed: 1 });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { tenantId: agents[0]!.tenantId, agentId: agents[0]!.id, windowStart: '2026-01-01T00:00:00.000Z', windowEnd: now.toISOString(), invocationCount: 4, errorCount: 1, errorRate: 0.25, latencyAverageMs: 10, latencyP95Ms: 18, throttleCount: 0, availability: 'AVAILABLE', collectedAt: now.toISOString() });
});

test('revoked access does not overwrite the most recent successful snapshot', async () => {
  let writes = 0;
  const repository = { getAwsConnection: async () => ({ ...connection, status: 'DISCONNECTED' }), putAgentMetricsSnapshot: async () => { writes += 1; } };
  const worker = new MetricsWorker({ repository: repository as never, assumer: {} as never, reader: {} as never, now: () => now });
  await assert.rejects(worker.collectAgent(agent('agt_00000000-0000-4000-8000-000000000001')), /CUSTOMER_ACCESS_REVOKED/);
  assert.equal(writes, 0);
});
