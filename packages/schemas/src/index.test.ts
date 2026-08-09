import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentSchema,
  agentTemplateSchema,
  auditEventSchema,
  awsConnectionSchema,
  createAgentId,
  createAgentTemplateId,
  createAuditEventId,
  createAwsConnectionId,
  createDeploymentId,
  createTenantId,
  deploymentSchema,
  processRefundInputSchema,
  tenantContextSchema,
  tenantMembershipSchema,
  tenantSchema
} from './index.js';

const timestamp = '2026-08-08T12:00:00.000Z';
const tenantId = createTenantId();

test('generated IDs are prefixed UUIDs accepted by their schemas', () => {
  assert.equal(tenantSchema.shape.id.safeParse(tenantId).success, true);
  assert.equal(awsConnectionSchema.shape.id.safeParse(createAwsConnectionId()).success, true);
  assert.equal(agentSchema.shape.id.safeParse(createAgentId()).success, true);
  assert.equal(deploymentSchema.shape.id.safeParse(createDeploymentId()).success, true);
  assert.equal(auditEventSchema.shape.id.safeParse(createAuditEventId()).success, true);
  assert.equal(
    agentTemplateSchema.shape.templateId.safeParse(createAgentTemplateId()).success,
    true
  );
  assert.notEqual(createTenantId(), createTenantId());
});

test('process_refund accepts only positive integer GBP minor units with complete input', () => {
  const valid = {
    orderId: 'ORD-1023',
    amountCents: 10_000,
    currency: 'GBP',
    reason: 'Damaged item'
  };
  assert.deepEqual(processRefundInputSchema.parse(valid), valid);
  for (const invalid of [
    { ...valid, amountCents: 0 },
    { ...valid, amountCents: -1 },
    { ...valid, amountCents: 1.5 },
    { ...valid, amountCents: '100' },
    { ...valid, currency: 'USD' },
    { ...valid, orderId: undefined },
    { ...valid, reason: '' }
  ])
    assert.equal(processRefundInputSchema.safeParse(invalid).success, false);
});

test('tenant schemas represent active and suspended tenants and reject malformed IDs', () => {
  const tenant = {
    id: tenantId,
    name: 'Acme',
    status: 'SUSPENDED' as const,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  assert.deepEqual(tenantSchema.parse(tenant), tenant);
  assert.equal(tenantSchema.safeParse({ ...tenant, id: 'acme' }).success, false);
  assert.equal(tenantSchema.safeParse({ ...tenant, status: 'DELETED' }).success, false);
});

test('membership and TenantContext remain separate from authenticated identity', () => {
  const membership = {
    tenantId,
    userId: 'cognito-subject',
    role: 'OWNER' as const,
    createdAt: timestamp
  };

  assert.deepEqual(tenantMembershipSchema.parse(membership), membership);
  assert.deepEqual(
    tenantContextSchema.parse({
      userId: membership.userId,
      tenantId: membership.tenantId,
      role: membership.role
    }),
    { userId: membership.userId, tenantId: membership.tenantId, role: membership.role }
  );
  assert.equal(tenantContextSchema.safeParse({ userId: membership.userId }).success, false);
});

test('resource schemas require tenant ownership and exclude credentials', () => {
  const awsConnection = {
    id: createAwsConnectionId(),
    tenantId,
    accountId: '123456789012',
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpad',
    externalId: 'external-id',
    status: 'VERIFIED' as const,
    createdBy: 'cognito-sub',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const parsed = awsConnectionSchema.parse({ ...awsConnection, accessKeyId: 'not-retained' });

  assert.deepEqual(parsed, awsConnection);
  assert.equal(
    awsConnectionSchema.safeParse({ ...awsConnection, tenantId: 'tenant-a' }).success,
    false
  );
});

test('deployment lifecycle and append-only audit event schemas validate', () => {
  const agentId = createAgentId();
  const deployment = {
    id: createDeploymentId(),
    tenantId,
    agentId,
    status: 'IN_PROGRESS' as const,
    stage: 'PROVISIONING_DEPENDENCIES' as const,
    requestedBy: 'cognito-subject',
    configurationRevision: 1,
    snapshot: {
      templateId: 'customer-support',
      templateVersion: '1',
      awsConnectionId: createAwsConnectionId(),
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'amazon.nova-lite-v1:0',
      capabilities: ['ORDER_LOOKUP'],
      guardrails: { refunds: { enabled: false } }
    },
    idempotencyKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: timestamp
  };

  assert.deepEqual(deploymentSchema.parse(deployment), deployment);
  assert.equal(deploymentSchema.safeParse({ ...deployment, status: 'CANCELLED' }).success, false);
  assert.deepEqual(
    auditEventSchema.parse({
      id: createAuditEventId(),
      tenantId,
      actorId: 'cognito-subject',
      action: 'agent.created',
      resourceType: 'agent',
      resourceId: agentId,
      metadata: { source: 'test' },
      createdAt: timestamp
    }).metadata,
    { source: 'test' }
  );
});
