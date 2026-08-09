import {
  agentIdSchema,
  agentTemplateIdSchema,
  auditEventIdSchema,
  agentArtifactIdSchema,
  awsConnectionIdSchema,
  deploymentIdSchema,
  tenantIdSchema
} from '@agent-launchpad/schemas';

/**
 * SAY-93 access patterns use only GetItem, Query, BatchGetItem and conditional writes:
 * tenant records and all tenant-owned records share TENANT#<tenantId>; memberships are queried
 * through GSI1 USER#<sub>; deployment histories use GSI2 tenant+agent; global templates use the
 * separate TEMPLATE partition and a sparse GSI1 TEMPLATES partition. No normal path uses Scan.
 */
export const controlPlaneKeys = {
  tenant: (tenantId: string) => ({ pk: `TENANT#${tenantIdSchema.parse(tenantId)}`, sk: 'META' }),
  membership: (tenantId: string, userId: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `MEMBER#${nonEmpty(userId)}`
  }),
  awsConnection: (tenantId: string, id: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `AWS#${awsConnectionIdSchema.parse(id)}`
  }),
  agent: (tenantId: string, id: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `AGENT#${agentIdSchema.parse(id)}`
  }),
  deployment: (tenantId: string, id: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `DEPLOYMENT#${deploymentIdSchema.parse(id)}`
  }),
  deploymentEvent: (tenantId: string, deploymentId: string, createdAt: string, id: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `DEPLOYMENT_EVENT#${deploymentIdSchema.parse(deploymentId)}#${createdAt}#${id}`
  }),
  deploymentIdempotency: (tenantId: string, agentId: string, keyHash: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `DEPLOYMENT_IDEMPOTENCY#${agentIdSchema.parse(agentId)}#${keyHash}`
  }),
  deploymentLock: (tenantId: string, agentId: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `DEPLOYMENT_LOCK#${agentIdSchema.parse(agentId)}`
  }),
  artifact: (tenantId: string, id: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `ARTIFACT#${agentArtifactIdSchema.parse(id)}`
  }),
  artifactDigest: (tenantId: string, agentId: string, sha256: string) => ({
    gsi2pk: `TENANT#${tenantIdSchema.parse(tenantId)}#AGENT#${agentIdSchema.parse(agentId)}`,
    gsi2sk: `ARTIFACT#${sha256}`
  }),
  audit: (tenantId: string, createdAt: string, id: string) => ({
    pk: `TENANT#${tenantIdSchema.parse(tenantId)}`,
    sk: `AUDIT#${createdAt}#${auditEventIdSchema.parse(id)}`
  }),
  template: (templateId: string, version: string) => ({
    pk: `TEMPLATE#${agentTemplateIdSchema.parse(templateId)}`,
    sk: `VERSION#${nonEmpty(version)}`
  }),
  userMemberships: (userId: string) => ({ gsi1pk: `USER#${nonEmpty(userId)}` }),
  globalTemplates: () => ({ gsi1pk: 'TEMPLATES' }),
  agentDeployments: (tenantId: string, agentId: string) => ({
    gsi2pk: `TENANT#${tenantIdSchema.parse(tenantId)}#AGENT#${agentIdSchema.parse(agentId)}`
  })
} as const;

export const sortKeyPrefixes = {
  members: 'MEMBER#',
  awsConnections: 'AWS#',
  agents: 'AGENT#',
  deployments: 'DEPLOYMENT#',
  deploymentEvents: 'DEPLOYMENT_EVENT#',
  artifacts: 'ARTIFACT#',
  audits: 'AUDIT#'
} as const;

function nonEmpty(value: string): string {
  if (!value.trim()) throw new Error('Key value must not be empty.');
  return value;
}
