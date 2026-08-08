import { z } from 'zod';

const uuidSuffixPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function prefixedIdSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}${uuidSuffixPattern}$`, 'i'), {
    message: `Expected an ID beginning with ${prefix}`
  });
}

const nonEmptyString = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });

export const tenantIdSchema = prefixedIdSchema('tnt_');
export const awsConnectionIdSchema = prefixedIdSchema('awc_');
export const agentIdSchema = prefixedIdSchema('agt_');
export const deploymentIdSchema = prefixedIdSchema('dep_');
export const auditEventIdSchema = prefixedIdSchema('evt_');
export const agentTemplateIdSchema = prefixedIdSchema('tpl_');

/** HTTP inputs deliberately exclude all server-owned persistence fields. */
export const pageQuerySchema = z
  .object({
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    nextToken: z.string().min(1).max(4096).optional()
  })
  .strict();

export const createAgentRequestSchema = z
  .object({
    name: nonEmptyString.max(200),
    templateId: agentTemplateIdSchema,
    templateVersion: nonEmptyString.max(100),
    model: nonEmptyString.max(512),
    region: nonEmptyString.max(64)
  })
  .strict();

export const updateAgentRequestSchema = z
  .object({
    name: nonEmptyString.max(200).optional(),
    model: nonEmptyString.max(512).optional(),
    region: nonEmptyString.max(64).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one editable field is required.');

export const tenantStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export const membershipRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export const awsConnectionStatusSchema = z.enum(['PENDING', 'VERIFIED', 'FAILED', 'DISCONNECTED']);
export const agentTemplateStatusSchema = z.enum(['ACTIVE', 'DEPRECATED']);
export const agentStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'DEPLOYING', 'FAILED', 'ARCHIVED']);
export const deploymentStatusSchema = z.enum([
  'QUEUED',
  'VALIDATING',
  'PACKAGING',
  'PROVISIONING_TOOLS',
  'UPLOADING_ARTIFACT',
  'CREATING_RUNTIME',
  'CONFIGURING_GATEWAY',
  'HEALTH_CHECK',
  'READY',
  'FAILED'
]);

export const tenantSchema = z.object({
  id: tenantIdSchema,
  name: nonEmptyString.max(200),
  status: tenantStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

/** A Cognito subject is an identity; a membership grants tenant access. */
export const tenantMembershipSchema = z.object({
  tenantId: tenantIdSchema,
  userId: nonEmptyString.max(256),
  role: membershipRoleSchema,
  createdAt: timestampSchema
});

export const awsConnectionSchema = z.object({
  id: awsConnectionIdSchema,
  tenantId: tenantIdSchema,
  accountId: z.string().regex(/^\d{12}$/, 'Expected a 12-digit AWS account ID'),
  region: nonEmptyString.max(64),
  roleArn: nonEmptyString.max(2048),
  externalId: nonEmptyString.max(1024),
  status: awsConnectionStatusSchema,
  createdAt: timestampSchema,
  verifiedAt: timestampSchema.optional()
});

/** Global catalog item. Templates deliberately have no tenantId. */
export const agentTemplateSchema = z.object({
  templateId: agentTemplateIdSchema,
  version: nonEmptyString.max(100),
  name: nonEmptyString.max(200),
  status: agentTemplateStatusSchema
});

export const agentSchema = z.object({
  id: agentIdSchema,
  tenantId: tenantIdSchema,
  templateId: agentTemplateIdSchema,
  templateVersion: nonEmptyString.max(100),
  name: nonEmptyString.max(200),
  model: nonEmptyString.max(512),
  region: nonEmptyString.max(64),
  status: agentStatusSchema,
  runtimeArn: nonEmptyString.max(2048).optional(),
  runtimeVersion: nonEmptyString.max(100).optional(),
  runtimeEndpoint: nonEmptyString.max(2048).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const deploymentSchema = z.object({
  id: deploymentIdSchema,
  tenantId: tenantIdSchema,
  agentId: agentIdSchema,
  status: deploymentStatusSchema,
  requestedBy: nonEmptyString.max(256),
  runtimeVersion: nonEmptyString.max(100).optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
  errorCode: nonEmptyString.max(128).optional(),
  errorMessage: nonEmptyString.max(4096).optional()
});

export const auditEventSchema = z.object({
  id: auditEventIdSchema,
  tenantId: tenantIdSchema,
  actorId: nonEmptyString.max(256),
  action: nonEmptyString.max(256),
  resourceType: nonEmptyString.max(128),
  resourceId: nonEmptyString.max(256),
  metadata: z.record(z.unknown()).optional(),
  createdAt: timestampSchema
});

/** Trusted application context, resolved from a Cognito identity and stored membership. */
export const tenantContextSchema = z.object({
  userId: nonEmptyString.max(256),
  tenantId: tenantIdSchema,
  role: membershipRoleSchema
});

export type Tenant = z.infer<typeof tenantSchema>;
export type TenantMembership = z.infer<typeof tenantMembershipSchema>;
export type AwsConnection = z.infer<typeof awsConnectionSchema>;
export type AgentTemplate = z.infer<typeof agentTemplateSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type TenantContext = z.infer<typeof tenantContextSchema>;
export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type AwsConnectionStatus = z.infer<typeof awsConnectionStatusSchema>;
export type AgentTemplateStatus = z.infer<typeof agentTemplateStatusSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;

function generateId(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

export const createTenantId = (): string => generateId('tnt_');
export const createAwsConnectionId = (): string => generateId('awc_');
export const createAgentId = (): string => generateId('agt_');
export const createDeploymentId = (): string => generateId('dep_');
export const createAuditEventId = (): string => generateId('evt_');
export const createAgentTemplateId = (): string => generateId('tpl_');

// Retained while the pre-SAY-93 control API contract still consumes it.
export const agentLaunchRequestSchema = z.object({
  agentId: z.string().min(1),
  customerId: z.string().min(1),
  environment: z.enum(['development', 'staging', 'production'])
});

export type AgentLaunchRequest = z.infer<typeof agentLaunchRequestSchema>;
