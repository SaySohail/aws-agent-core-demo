import assert from 'node:assert/strict';
import test from 'node:test';
import { customerSupportTemplate, type AgentTemplate, type Tenant, type TenantMembership } from '@agent-launchpad/schemas';
import { demoSeedFailureMessage, readDemoSeedConfig, seedDemo } from './seed-demo.js';

class DemoRepository {
  tenants = new Map<string, Tenant>();
  memberships = new Map<string, TenantMembership>();
  templates = new Map<string, AgentTemplate>();

  async createTenant(value: Tenant): Promise<void> {
    if (this.tenants.has(value.id)) throw conditionalConflict();
    this.tenants.set(value.id, value);
  }
  async getTenant(id: string): Promise<Tenant | undefined> {
    return this.tenants.get(id);
  }
  async createMembership(value: TenantMembership): Promise<void> {
    const key = `${value.tenantId}:${value.userId}`;
    if (this.memberships.has(key)) throw conditionalConflict();
    this.memberships.set(key, value);
  }
  async getMembership(tenantId: string, userId: string): Promise<TenantMembership | undefined> {
    return this.memberships.get(`${tenantId}:${userId}`);
  }
  async createAgentTemplate(value: AgentTemplate): Promise<void> {
    const key = `${value.templateId}:${value.version}`;
    if (this.templates.has(key)) throw conditionalConflict();
    this.templates.set(key, value);
  }
  async getAgentTemplate(templateId: string, version: string): Promise<AgentTemplate | undefined> {
    return this.templates.get(`${templateId}:${version}`);
  }
}

function conditionalConflict(): Error {
  const error = new Error('conflict');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

test('demo seed is idempotent and creates only its tenant, membership, and template', async () => {
  const repository = new DemoRepository();
  const config = { userId: 'cognito-subject' };
  await seedDemo(repository, config, () => new Date('2026-08-10T00:00:00.000Z'));
  await seedDemo(repository, config, () => new Date('2026-08-10T00:01:00.000Z'));

  assert.equal(repository.tenants.size, 1);
  assert.equal(repository.memberships.size, 1);
  assert.equal(repository.templates.size, 1);
  assert.deepEqual([...repository.tenants.values()][0]?.status, 'ACTIVE');
  assert.deepEqual([...repository.memberships.values()][0]?.role, 'ADMIN');
  assert.deepEqual([...repository.templates.values()][0], customerSupportTemplate);
});

test('demo seed requires all deployment environment values', () => {
  assert.throws(() => readDemoSeedConfig({}), /CONTROL_PLANE_TABLE_NAME/);
  assert.throws(
    () => readDemoSeedConfig({ CONTROL_PLANE_TABLE_NAME: 'table' }),
    /AWS_REGION/
  );
  assert.throws(
    () => readDemoSeedConfig({ CONTROL_PLANE_TABLE_NAME: 'table', AWS_REGION: 'eu-west-1' }),
    /DEMO_USER_SUB/
  );
});

test('demo seed reports actionable, value-free AWS credential failures', () => {
  const error = new Error('credential text that must not be printed');
  error.name = 'ExpiredTokenException';
  assert.equal(demoSeedFailureMessage(error), 'AWS session expired. Reauthenticate and retry.');
});

test('demo seed accepts an existing platform template without reading its record', async () => {
  const repository = new DemoRepository();
  repository.templates.set(
    `${customerSupportTemplate.templateId}:${customerSupportTemplate.version}`,
    customerSupportTemplate
  );
  repository.getAgentTemplate = async () => {
    throw new Error('Persisted agent template record did not match its domain schema.');
  };

  await seedDemo(repository, { userId: 'cognito-subject' });
  assert.equal(repository.templates.size, 1);
});
