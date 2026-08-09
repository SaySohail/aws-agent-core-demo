import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Agent,
  AgentArtifact,
  AuditEvent,
  Deployment,
  Tenant,
  TenantMembership
} from '@agent-launchpad/schemas';
import {
  ControlPlaneRepository,
  controlPlaneKeys,
  decodePageToken,
  encodePageToken,
  fromPersistence,
  toPersistence,
  type PersistenceClient,
  type QueryInput,
  type QueryResult,
  type UpdateInput
} from './index.js';

const at = '2026-01-01T00:00:00.000Z';
const tenantA: Tenant = {
  id: 'tnt_00000000-0000-4000-8000-000000000001',
  name: 'A',
  status: 'ACTIVE',
  createdAt: at,
  updatedAt: at
};
const tenantB: Tenant = {
  id: 'tnt_00000000-0000-4000-8000-000000000002',
  name: 'B',
  status: 'ACTIVE',
  createdAt: at,
  updatedAt: at
};
const agentId = 'agt_00000000-0000-4000-8000-000000000001';
const agent = (tenantId: string, id = agentId): Agent => ({
  id,
  tenantId,
  templateId: 'tpl_00000000-0000-4000-8000-000000000001',
  templateVersion: '1',
  name: 'Agent',
  model: 'model',
  region: 'us-east-1',
  configuration: {
    configurationVersion: 1,
    template: { id: 'tpl_00000000-0000-4000-8000-000000000001', version: '1' },
    name: 'Agent',
    deploymentTarget: {
      awsConnectionId: 'awc_00000000-0000-4000-8000-000000000001',
      accountId: '123456789012',
      region: 'us-east-1'
    },
    model: { modelId: 'amazon.nova-lite-v1:0' },
    capabilities: ['ORDER_LOOKUP'],
    guardrails: { refunds: { enabled: false } }
  },
  revision: 1,
  status: 'DRAFT',
  createdAt: at,
  updatedAt: at
});
const membership = (tenantId: string, userId: string): TenantMembership => ({
  tenantId,
  userId,
  role: 'MEMBER',
  createdAt: at
});

class MemoryStore implements PersistenceClient {
  readonly records = new Map<string, Record<string, unknown>>();
  readonly operations: string[] = [];
  private id(key: Record<string, string>) {
    return `${key.pk}|${key.sk}`;
  }
  async get(key: Record<string, string>) {
    this.operations.push('get');
    return this.records.get(this.id(key));
  }
  async batchGet(keys: readonly Record<string, string>[]) {
    this.operations.push('batchGet');
    return keys.flatMap((key) => {
      const record = this.records.get(this.id(key));
      return record ? [record] : [];
    });
  }
  async put(item: Record<string, unknown>, condition?: string) {
    this.operations.push('put');
    const key = { pk: String(item.pk), sk: String(item.sk) };
    if (condition && this.records.has(this.id(key))) throw new Error('ConditionalCheckFailed');
    this.records.set(this.id(key), item);
  }
  async update({ key, updates, condition }: UpdateInput) {
    this.operations.push('update');
    const current = this.records.get(this.id(key));
    if (condition && !current) throw new Error('ConditionalCheckFailed');
    if (current) Object.assign(current, updates);
  }
  async delete(key: Record<string, string>, condition?: string) {
    this.operations.push('delete');
    if (condition && !this.records.has(this.id(key))) throw new Error('ConditionalCheckFailed');
    this.records.delete(this.id(key));
  }
  async query(input: QueryInput): Promise<QueryResult> {
    this.operations.push('query');
    const sort =
      input.partitionKey === 'pk'
        ? 'sk'
        : input.partitionKey === 'gsi1pk'
          ? 'gsi1sk'
          : input.partitionKey === 'gsi2pk'
            ? 'gsi2sk'
            : 'gsi3sk';
    const rows = [...this.records.values()]
      .filter(
        (item) =>
          item[input.partitionKey] === input.partitionValue &&
          (!input.sortKeyPrefix || String(item[sort]).startsWith(input.sortKeyPrefix))
      )
      .sort((a, b) => String(a[sort]).localeCompare(String(b[sort])));
    const start = input.cursor
      ? rows.findIndex((item) => item.pk === input.cursor?.pk && item.sk === input.cursor?.sk) + 1
      : 0;
    const items = rows.slice(start, input.limit ? start + input.limit : undefined);
    const last = items.at(-1);
    return last && start + items.length < rows.length
      ? { items, nextKey: { pk: String(last.pk), sk: String(last.sk) } }
      : { items };
  }
}

async function repository() {
  const store = new MemoryStore();
  const repo = new ControlPlaneRepository(store);
  await repo.createTenant(tenantA);
  await repo.createTenant(tenantB);
  return { store, repo };
}

test('centralized keys reject invalid IDs and encode tenant isolation', () => {
  assert.deepEqual(controlPlaneKeys.agent(tenantA.id, agentId), {
    pk: `TENANT#${tenantA.id}`,
    sk: `AGENT#${agentId}`
  });
  assert.throws(() => controlPlaneKeys.agent(tenantA.id, 'agent-name'));
});

test('page tokens are opaque and reject malformed data', () => {
  const token = encodePageToken({ pk: 'TENANT#A', sk: 'AGENT#A' });
  assert.deepEqual(decodePageToken(token), { pk: 'TENANT#A', sk: 'AGENT#A' });
  assert.throws(() => decodePageToken('not-a-token'));
});

test('domain records round-trip through persistence while physical keys stay internal', () => {
  const persisted = toPersistence.agent(agent(tenantA.id));
  assert.equal(persisted.pk, `TENANT#${tenantA.id}`);
  assert.equal(persisted.sk, `AGENT#${agentId}`);
  assert.deepEqual(fromPersistence.agent(persisted), agent(tenantA.id));
});

test('tenant scoped resources cannot cross tenant partitions, update, or delete', async () => {
  const { repo } = await repository();
  await repo.createAgent(agent(tenantA.id));
  await repo.createAgent(agent(tenantB.id));
  assert.equal((await repo.getAgent(tenantA.id, agentId))?.tenantId, tenantA.id);
  assert.equal((await repo.getAgent(tenantB.id, agentId))?.tenantId, tenantB.id);
  const contextA = { userId: 'user-a', tenantId: tenantA.id, role: 'MEMBER' as const };
  await repo.updateAgent(
    contextA,
    agentId,
    {
      templateId: 'tpl_00000000-0000-4000-8000-000000000001',
      templateVersion: '1',
      name: 'Agent A',
      model: 'model',
      region: 'us-east-1',
      configuration: { ...agent(tenantA.id).configuration, name: 'Agent A' },
      revision: 2,
      updatedAt: at
    },
    1
  );
  assert.equal((await repo.getAgent(tenantB.id, agentId))?.name, 'Agent');
  await repo.deleteAgent(contextA, agentId);
  assert.equal((await repo.getAgent(tenantB.id, agentId))?.tenantId, tenantB.id);
  await assert.rejects(
    repo.updateAgent(
      contextA,
      'agt_00000000-0000-4000-8000-000000000099',
      {
        templateId: 'tpl_00000000-0000-4000-8000-000000000001',
        templateVersion: '1',
        name: 'x',
        model: 'model',
        region: 'us-east-1',
        configuration: { ...agent(tenantA.id).configuration, name: 'x' },
        revision: 2,
        updatedAt: at
      },
      1
    )
  );
  await assert.rejects(repo.deleteAgent(contextA, 'agt_00000000-0000-4000-8000-000000000099'));
});

test('memberships resolve only persisted active tenant contexts and support many tenants', async () => {
  const { repo } = await repository();
  await repo.createMembership(membership(tenantA.id, 'user-a'));
  await repo.createMembership(membership(tenantB.id, 'user-a'));
  assert.equal(await repo.resolveTenantContext('no-membership', tenantA.id), undefined);
  assert.equal((await repo.resolveTenantContext('user-a', tenantA.id))?.tenantId, tenantA.id);
  assert.deepEqual(
    (await repo.listTenantContexts('user-a')).items.map((context) => context.tenantId).sort(),
    [tenantA.id, tenantB.id]
  );
  assert.equal((await repo.listMembers(tenantA.id)).items.length, 1);
});

test('creates are conditional, lists paginate, and normal access never scans', async () => {
  const { repo, store } = await repository();
  await repo.createAgent(agent(tenantA.id));
  await assert.rejects(repo.createAgent(agent(tenantA.id)));
  await repo.createAgent(agent(tenantA.id, 'agt_00000000-0000-4000-8000-000000000002'));
  const first = await repo.listAgents(tenantA.id, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextToken);
  assert.equal((await repo.listAgents(tenantA.id, { nextToken: first.nextToken })).items.length, 1);
  assert.equal(store.operations.includes('scan'), false);
});

test('deployments and audit events are chronological and malformed persistence is rejected', async () => {
  const { repo } = await repository();
  await repo.createAgent(agent(tenantA.id));
  const deployment = (id: string, createdAt: string): Deployment => ({
    id,
    tenantId: tenantA.id,
    agentId,
    status: 'QUEUED',
    stage: 'QUEUED',
    requestedBy: 'user-a',
    configurationRevision: 1,
    snapshot: {
      templateId: 'tpl_00000000-0000-4000-8000-000000000001',
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
    createdAt
  });
  await repo.createDeployment(
    deployment('dep_00000000-0000-4000-8000-000000000002', '2026-01-02T00:00:00.000Z')
  );
  await repo.createDeployment(
    deployment('dep_00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000Z')
  );
  const artifact: AgentArtifact = {
    id: 'art_00000000-0000-4000-8000-000000000001',
    tenantId: tenantA.id,
    agentId,
    templateId: 'tpl_00000000-0000-4000-8000-000000000001',
    templateVersion: '1',
    configurationVersion: 1,
    runtime: 'NODE_22',
    entryPoint: ['opentelemetry-instrument', 'dist/app.js'],
    sha256: 'c'.repeat(64),
    sizeBytes: 12,
    bucket: 'agent-launchpad-artifacts-123456789012-us-east-1',
    objectKey: `agents/${agentId}/artifacts/${'c'.repeat(64)}/agent.zip`,
    s3VersionId: 'version-1',
    status: 'READY',
    createdBy: 'user-a',
    createdAt: at,
    updatedAt: at
  };
  await repo.createAgentArtifact(artifact);
  assert.equal(
    (await repo.findAgentArtifactByDigest(tenantA.id, agentId, artifact.sha256))?.id,
    artifact.id
  );
  await repo.attachDeploymentArtifact(
    tenantA.id,
    'dep_00000000-0000-4000-8000-000000000001',
    artifact.id,
    artifact.sha256
  );
  assert.deepEqual(
    (await repo.getDeployment(tenantA.id, 'dep_00000000-0000-4000-8000-000000000001'))?.snapshot
      .artifactId,
    artifact.id
  );
  await assert.rejects(
    repo.attachDeploymentArtifact(
      tenantA.id,
      'dep_00000000-0000-4000-8000-000000000001',
      'art_00000000-0000-4000-8000-000000000002',
      'd'.repeat(64)
    )
  );
  assert.deepEqual(
    (await repo.listDeploymentsForAgent(tenantA.id, agentId)).items.map((value) => value.id),
    ['dep_00000000-0000-4000-8000-000000000001', 'dep_00000000-0000-4000-8000-000000000002']
  );
  const audit = (id: string, createdAt: string): AuditEvent => ({
    id,
    tenantId: tenantA.id,
    actorId: 'user-a',
    action: 'READ',
    resourceType: 'AGENT',
    resourceId: agentId,
    createdAt
  });
  await repo.appendAuditEvent(
    audit('evt_00000000-0000-4000-8000-000000000002', '2026-01-02T00:00:00.000Z')
  );
  await repo.appendAuditEvent(
    audit('evt_00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00.000Z')
  );
  assert.deepEqual(
    (await repo.listAuditEvents(tenantA.id)).items.map((value) => value.id),
    ['evt_00000000-0000-4000-8000-000000000001', 'evt_00000000-0000-4000-8000-000000000002']
  );
  assert.throws(() => fromPersistence.agent({ pk: 'TENANT#x', sk: 'AGENT#x' }));
});
