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
export const deploymentEventIdSchema = prefixedIdSchema('dpe_');
export const agentArtifactIdSchema = prefixedIdSchema('art_');
export const runtimeVersionIdSchema = prefixedIdSchema('rtv_');
export const auditEventIdSchema = prefixedIdSchema('evt_');
/** Platform template IDs are stable, human-readable product identifiers. */
export const agentTemplateIdSchema = z.string().regex(/^(?:customer-support|tpl_[0-9a-f-]+)$/i);

/** Customer-support tool contracts are shared by the agent and data-plane Lambda boundary. */
export const supportOrderIdSchema = z
  .string()
  .trim()
  .regex(/^ORD-[A-Z0-9]{4,32}$/, 'Expected an order ID like ORD-1023.');
export const getOrderInputSchema = z.object({ orderId: supportOrderIdSchema }).strict();
export const searchOrdersInputSchema = z
  .object({ customerEmail: z.string().trim().email().max(254) })
  .strict();
export const createSupportTicketInputSchema = z
  .object({
    subject: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(4000),
    orderId: supportOrderIdSchema.optional()
  })
  .strict();
export const processRefundInputSchema = z
  .object({
    orderId: supportOrderIdSchema,
    amountCents: z.number().int().positive(),
    currency: z.literal('GBP'),
    reason: z.string().trim().min(3).max(500)
  })
  .strict();

/** Demo-only control: policy infrastructure renders this value into Cedar at deployment time. */
export const REFUND_AUTO_APPROVAL_LIMIT_CENTS = 10_000;
export const CUSTOMER_SUPPORT_TEMPLATE_ID = 'customer-support';
export const CUSTOMER_SUPPORT_TEMPLATE_VERSION = '1';
export const agentCapabilitySchema = z.enum([
  'ORDER_LOOKUP',
  'ORDER_SEARCH',
  'CREATE_SUPPORT_TICKET',
  'PROCESS_REFUND'
]);
export const customerSupportCapabilities = [
  'ORDER_LOOKUP',
  'ORDER_SEARCH',
  'CREATE_SUPPORT_TICKET',
  'PROCESS_REFUND'
] as const;
export const customerSupportCapabilityTools = {
  ORDER_LOOKUP: 'get_order',
  ORDER_SEARCH: 'search_orders',
  CREATE_SUPPORT_TICKET: 'create_support_ticket',
  PROCESS_REFUND: 'process_refund'
} as const;

export const refundGuardrailSchema = z.object({
  enabled: z.boolean(),
  autoApprovalLimitCents: z.number().int().positive().optional(),
  currency: z.literal('GBP').optional()
});
export const agentConfigurationSchema = z
  .object({
    configurationVersion: z.literal(1),
    template: z.object({ id: agentTemplateIdSchema, version: nonEmptyString.max(100) }).strict(),
    name: nonEmptyString
      .max(100)
      .refine(noControlCharacters, 'Control characters are not allowed.'),
    deploymentTarget: z
      .object({
        awsConnectionId: awsConnectionIdSchema,
        accountId: z.string().regex(/^\d{12}$/),
        region: nonEmptyString.max(64)
      })
      .strict(),
    model: z.object({ modelId: nonEmptyString.max(512) }).strict(),
    capabilities: z.array(agentCapabilitySchema).max(20),
    guardrails: z.object({ refunds: refundGuardrailSchema }).strict()
  })
  .strict();

export const customerSupportGatewayToolDefinitions = [
  {
    name: 'get_order',
    description: 'Retrieve current details for one order when the exact order ID is known.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { orderId: { type: 'string', pattern: '^ORD-[A-Z0-9]{4,32}$' } },
      required: ['orderId']
    }
  },
  {
    name: 'search_orders',
    description: "Find a customer's recent orders when the exact order ID is not known.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { customerEmail: { type: 'string', format: 'email', maxLength: 254 } },
      required: ['customerEmail']
    }
  },
  {
    name: 'create_support_ticket',
    description: 'Create a customer-support case after sufficient issue information is available.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string', minLength: 3, maxLength: 160 },
        description: { type: 'string', minLength: 10, maxLength: 4000 },
        orderId: { type: 'string', pattern: '^ORD-[A-Z0-9]{4,32}$' }
      },
      required: ['subject', 'description']
    }
  },
  {
    name: 'process_refund',
    description:
      'Process a fake/demo GBP refund after confirming the requested amount, reason, and exact order ID.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orderId: { type: 'string', pattern: '^ORD-[A-Z0-9]{4,32}$' },
        amountCents: { type: 'integer', minimum: 1 },
        currency: { type: 'string', enum: ['GBP'] },
        reason: { type: 'string', minLength: 3, maxLength: 500 }
      },
      required: ['orderId', 'amountCents', 'currency', 'reason']
    }
  }
] as const;
export const customerSupportGatewayTargetNames = {
  get_order: 'GetOrderTarget',
  search_orders: 'SearchOrdersTarget',
  create_support_ticket: 'CreateTicketTarget',
  process_refund: 'ProcessRefundTarget'
} as const;

/** HTTP inputs deliberately exclude all server-owned persistence fields. */
export const pageQuerySchema = z
  .object({
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    nextToken: z.string().min(1).max(4096).optional()
  })
  .strict();

export const createAgentRequestSchema = z
  .object({
    name: nonEmptyString.max(100).refine(noControlCharacters),
    templateId: agentTemplateIdSchema,
    templateVersion: nonEmptyString.max(100),
    modelId: nonEmptyString.max(512),
    awsConnectionId: awsConnectionIdSchema,
    capabilities: z.array(agentCapabilitySchema).max(20),
    guardrails: z.object({ refunds: refundGuardrailSchema }).strict()
  })
  .strict();

export const updateAgentRequestSchema = z
  .object({
    name: nonEmptyString.max(100).refine(noControlCharacters),
    templateId: agentTemplateIdSchema,
    templateVersion: nonEmptyString.max(100),
    modelId: nonEmptyString.max(512),
    awsConnectionId: awsConnectionIdSchema,
    capabilities: z.array(agentCapabilitySchema).max(20),
    guardrails: z.object({ refunds: refundGuardrailSchema }).strict(),
    expectedRevision: z.number().int().positive()
  })
  .strict();

export const tenantStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);
export const membershipRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export const awsConnectionStatusSchema = z.enum([
  'PENDING',
  'VERIFYING',
  'VERIFIED',
  'FAILED',
  'DISCONNECTED'
]);
export const agentTemplateStatusSchema = z.enum(['ACTIVE', 'DEPRECATED', 'DISABLED']);
export const agentStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'DEPLOYING', 'FAILED', 'ARCHIVED']);
export const deploymentStageSchema = z.enum([
  'QUEUED',
  'VALIDATING',
  'VERIFYING_CUSTOMER_ACCESS',
  'PREFLIGHT_REGION',
  'PREFLIGHT_MODEL',
  'PREFLIGHT_IAM',
  'PREFLIGHT_STORAGE',
  'PREFLIGHT_AGENTCORE',
  'ENSURING_ARTIFACT',
  'PROVISIONING_DEPENDENCIES',
  'WAITING_FOR_DEPENDENCIES',
  'DEPLOYING_RUNTIME',
  'WAITING_FOR_RUNTIME',
  'HEALTH_CHECKING',
  'PROMOTING_ENDPOINT',
  'WAITING_FOR_ENDPOINT',
  'READY',
  'FAILED'
]);
/** Status is deliberately terminal-oriented; stage supplies product-facing progress. */
export const deploymentStatusSchema = z.enum(['QUEUED', 'IN_PROGRESS', 'READY', 'FAILED']);
export const agentArtifactStatusSchema = z.enum(['BUILDING', 'UPLOADING', 'READY', 'FAILED']);

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
  bootstrapVersion: nonEmptyString.max(32).optional(),
  createdBy: nonEmptyString.max(256),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  verifiedAt: timestampSchema.optional(),
  lastVerifiedAt: timestampSchema.optional(),
  lastVerificationErrorCode: nonEmptyString.max(128).optional()
});

export const createAwsConnectionRequestSchema = z
  .object({
    accountId: z.string().regex(/^\d{12}$/, 'Expected a 12-digit AWS account ID'),
    region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, 'Expected an AWS region')
  })
  .strict();

/** Global catalog item. Templates deliberately have no tenantId. */
export const agentTemplateSchema = z
  .object({
    templateId: agentTemplateIdSchema,
    version: nonEmptyString.max(100),
    name: nonEmptyString.max(200),
    description: nonEmptyString.max(2000),
    status: agentTemplateStatusSchema,
    supportedCapabilities: z.array(agentCapabilitySchema).min(1),
    supportedModelIds: z.array(nonEmptyString.max(512)).min(1),
    guardrails: z
      .object({
        refunds: z
          .object({
            defaultAutoApprovalLimitCents: z.number().int().positive(),
            maximumAutoApprovalLimitCents: z.number().int().positive(),
            currency: z.literal('GBP')
          })
          .strict()
      })
      .strict()
  })
  .strict();

export const bedrockModelCatalogEntrySchema = z
  .object({
    modelId: nonEmptyString.max(512),
    displayName: nonEmptyString.max(200),
    status: z.enum(['ACTIVE', 'DISABLED']),
    allowedTemplateIds: z.array(agentTemplateIdSchema).min(1),
    supportedRegions: z.array(nonEmptyString.max(64)).min(1),
    runtimeApi: z.literal('BEDROCK_CONVERSE')
  })
  .strict();

/** Intentionally maintained platform data, never supplied by a browser or fetched from AWS. */
export const customerSupportTemplate: AgentTemplate = {
  templateId: CUSTOMER_SUPPORT_TEMPLATE_ID,
  version: CUSTOMER_SUPPORT_TEMPLATE_VERSION,
  name: 'Customer Support Agent',
  description: 'Resolve customer order questions, support tickets, and approved demo refunds.',
  status: 'ACTIVE',
  supportedCapabilities: [...customerSupportCapabilities],
  supportedModelIds: ['amazon.nova-lite-v1:0'],
  guardrails: {
    refunds: {
      defaultAutoApprovalLimitCents: REFUND_AUTO_APPROVAL_LIMIT_CENTS,
      maximumAutoApprovalLimitCents: REFUND_AUTO_APPROVAL_LIMIT_CENTS,
      currency: 'GBP'
    }
  }
};
export const bedrockModelCatalog: readonly BedrockModelCatalogEntry[] = [
  {
    modelId: 'amazon.nova-lite-v1:0',
    displayName: 'Amazon Nova Lite',
    status: 'ACTIVE',
    allowedTemplateIds: [CUSTOMER_SUPPORT_TEMPLATE_ID],
    supportedRegions: ['us-east-1', 'us-west-2', 'eu-west-1'],
    runtimeApi: 'BEDROCK_CONVERSE'
  }
];

export const agentSchema = z.object({
  id: agentIdSchema,
  tenantId: tenantIdSchema,
  templateId: agentTemplateIdSchema,
  templateVersion: nonEmptyString.max(100),
  name: nonEmptyString.max(200),
  model: nonEmptyString.max(512),
  region: nonEmptyString.max(64),
  configuration: agentConfigurationSchema,
  revision: z.number().int().positive(),
  status: agentStatusSchema,
  runtimeArn: nonEmptyString.max(2048).optional(),
  runtimeId: nonEmptyString.max(512).optional(),
  runtimeVersion: nonEmptyString.max(100).optional(),
  runtimeEndpoint: nonEmptyString.max(2048).optional(),
  runtimeEndpointName: nonEmptyString.max(128).optional(),
  /** Trusted AgentCore deployment response only; never browser-provided. */
  runtimeWorkloadIdentityArn: nonEmptyString.max(2048).optional(),
  gatewayArn: nonEmptyString.max(2048).optional(),
  /** Trusted AgentCore deployment response only; never browser-provided. */
  gatewayWorkloadIdentityArn: nonEmptyString.max(2048).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});

export const deploymentSchema = z.object({
  id: deploymentIdSchema,
  tenantId: tenantIdSchema,
  agentId: agentIdSchema,
  status: deploymentStatusSchema,
  stage: deploymentStageSchema,
  requestedBy: nonEmptyString.max(256),
  configurationRevision: z.number().int().positive(),
  snapshot: z
    .object({
      templateId: agentTemplateIdSchema,
      templateVersion: nonEmptyString.max(100),
      artifactId: agentArtifactIdSchema.optional(),
      artifactSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      awsConnectionId: awsConnectionIdSchema,
      accountId: z.string().regex(/^\d{12}$/),
      region: nonEmptyString.max(64),
      modelId: nonEmptyString.max(512),
      /** Server-resolved dependency output; never supplied by the browser. */
      gatewayUrl: z.string().url().max(2048).optional(),
      capabilities: z.array(agentCapabilitySchema).max(20),
      guardrails: z.object({ refunds: refundGuardrailSchema }).strict()
    })
    .strict(),
  idempotencyKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  executionArn: nonEmptyString.max(2048).optional(),
  runtimeVersion: nonEmptyString.max(100).optional(),
  runtimeId: nonEmptyString.max(512).optional(),
  runtimeEndpointArn: nonEmptyString.max(2048).optional(),
  runtimeEndpointName: nonEmptyString.max(128).optional(),
  runtimeWorkloadIdentityArn: nonEmptyString.max(2048).optional(),
  gatewayArn: nonEmptyString.max(2048).optional(),
  gatewayWorkloadIdentityArn: nonEmptyString.max(2048).optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
  errorCode: nonEmptyString.max(128).optional(),
  errorMessage: nonEmptyString.max(4096).optional()
});

export const deploymentEventSchema = z
  .object({
    id: deploymentEventIdSchema,
    tenantId: tenantIdSchema,
    deploymentId: deploymentIdSchema,
    fromStage: deploymentStageSchema.optional(),
    toStage: deploymentStageSchema,
    status: deploymentStatusSchema,
    errorCode: nonEmptyString.max(128).optional(),
    createdAt: timestampSchema
  })
  .strict();

/** Immutable content-addressed package produced from one exact draft revision. */
export const agentArtifactSchema = z.object({
  id: agentArtifactIdSchema,
  tenantId: tenantIdSchema,
  agentId: agentIdSchema,
  templateId: agentTemplateIdSchema,
  templateVersion: nonEmptyString.max(100),
  configurationVersion: z.number().int().positive(),
  runtime: z.literal('NODE_22'),
  entryPoint: z.literal('dist/app.js'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  bucket: nonEmptyString.max(255).optional(),
  objectKey: nonEmptyString.max(1024).optional(),
  s3VersionId: nonEmptyString.max(1024).optional(),
  status: agentArtifactStatusSchema,
  createdBy: nonEmptyString.max(256),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  errorCode: nonEmptyString.max(128).optional()
});

/** Immutable record for an AgentCore Runtime candidate; later deployments only append. */
export const runtimeVersionSchema = z
  .object({
    id: runtimeVersionIdSchema,
    tenantId: tenantIdSchema,
    agentId: agentIdSchema,
    deploymentId: deploymentIdSchema,
    runtimeId: nonEmptyString.max(512),
    runtimeArn: nonEmptyString.max(2048),
    runtimeVersion: nonEmptyString.max(100),
    artifactId: agentArtifactIdSchema,
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    configurationRevision: z.number().int().positive(),
    workloadIdentityArn: nonEmptyString.max(2048),
    state: z.enum(['CREATING', 'UPDATING', 'READY', 'FAILED']),
    endpointName: nonEmptyString.max(128).optional(),
    endpointArn: nonEmptyString.max(2048).optional(),
    endpointTargetVersion: nonEmptyString.max(100).optional(),
    endpointLiveVersion: nonEmptyString.max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

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
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type BedrockModelCatalogEntry = z.infer<typeof bedrockModelCatalogEntrySchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type DeploymentEvent = z.infer<typeof deploymentEventSchema>;
export type AgentArtifact = z.infer<typeof agentArtifactSchema>;
export type RuntimeVersion = z.infer<typeof runtimeVersionSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type TenantContext = z.infer<typeof tenantContextSchema>;
export type TenantStatus = z.infer<typeof tenantStatusSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type AwsConnectionStatus = z.infer<typeof awsConnectionStatusSchema>;
export type AgentTemplateStatus = z.infer<typeof agentTemplateStatusSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type DeploymentStage = z.infer<typeof deploymentStageSchema>;
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type CreateAwsConnectionRequest = z.infer<typeof createAwsConnectionRequestSchema>;

export interface AgentDefinitionValidationIssue {
  readonly code: string;
  readonly message: string;
}

/** Static-only readiness check shared by packaging and deployment preflight callers. */
export function validateAgentDefinitionForDeployment(
  agent: Agent,
  template: AgentTemplate | undefined,
  connection: AwsConnection | undefined,
  catalog: readonly BedrockModelCatalogEntry[] = bedrockModelCatalog
): readonly AgentDefinitionValidationIssue[] {
  const issues: AgentDefinitionValidationIssue[] = [];
  if (agent.status !== 'DRAFT')
    issues.push({ code: 'AGENT_NOT_DRAFT', message: 'Agent must be a draft.' });
  if (
    !template ||
    template.templateId !== agent.templateId ||
    template.version !== agent.templateVersion
  )
    issues.push({ code: 'TEMPLATE_NOT_FOUND', message: 'Exact template version is unavailable.' });
  else if (template.status !== 'ACTIVE')
    issues.push({ code: 'TEMPLATE_INACTIVE', message: 'Template is not active.' });
  if (!connection)
    issues.push({ code: 'CONNECTION_NOT_FOUND', message: 'AWS connection is unavailable.' });
  else {
    if (connection.status !== 'VERIFIED')
      issues.push({ code: 'CONNECTION_NOT_VERIFIED', message: 'AWS connection is not verified.' });
    if (
      connection.id !== agent.configuration.deploymentTarget.awsConnectionId ||
      connection.accountId !== agent.configuration.deploymentTarget.accountId ||
      connection.region !== agent.configuration.deploymentTarget.region
    )
      issues.push({
        code: 'TARGET_MISMATCH',
        message: 'Stored deployment target is inconsistent.'
      });
  }
  const model = catalog.find((item) => item.modelId === agent.configuration.model.modelId);
  if (
    !model ||
    model.status !== 'ACTIVE' ||
    model.runtimeApi !== 'BEDROCK_CONVERSE' ||
    !model.allowedTemplateIds.includes(agent.templateId) ||
    !model.supportedRegions.includes(agent.configuration.deploymentTarget.region)
  )
    issues.push({
      code: 'MODEL_INVALID',
      message: 'Model is not compatible with this deployment target.'
    });
  if (
    !template ||
    agent.configuration.capabilities.some(
      (value) => !template.supportedCapabilities.includes(value)
    )
  )
    issues.push({
      code: 'CAPABILITIES_INVALID',
      message: 'Selected capabilities are not supported.'
    });
  const refunds = agent.configuration.guardrails.refunds;
  const refundEnabled = agent.configuration.capabilities.includes('PROCESS_REFUND');
  if (
    refundEnabled !== refunds.enabled ||
    (refundEnabled &&
      (!refunds.autoApprovalLimitCents ||
        refunds.currency !== template?.guardrails.refunds.currency ||
        refunds.autoApprovalLimitCents >
          (template?.guardrails.refunds.maximumAutoApprovalLimitCents ?? 0)))
  )
    issues.push({
      code: 'REFUND_GUARDRAIL_INVALID',
      message: 'Refund governance configuration is invalid.'
    });
  return issues;
}

function generateId(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

function noControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export const createTenantId = (): string => generateId('tnt_');
export const createAwsConnectionId = (): string => generateId('awc_');
export const createAgentId = (): string => generateId('agt_');
export const createDeploymentId = (): string => generateId('dep_');
export const createDeploymentEventId = (): string => generateId('dpe_');
export const createAgentArtifactId = (): string => generateId('art_');
export const createRuntimeVersionId = (): string => generateId('rtv_');
export const createAuditEventId = (): string => generateId('evt_');
export const createAgentTemplateId = (): string => generateId('tpl_');

// Retained while the pre-SAY-93 control API contract still consumes it.
export const agentLaunchRequestSchema = z.object({
  agentId: z.string().min(1),
  customerId: z.string().min(1),
  environment: z.enum(['development', 'staging', 'production'])
});

export type AgentLaunchRequest = z.infer<typeof agentLaunchRequestSchema>;
