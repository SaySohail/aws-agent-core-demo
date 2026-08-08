import {
  agentSchema,
  agentTemplateSchema,
  auditEventSchema,
  awsConnectionSchema,
  deploymentSchema,
  tenantMembershipSchema,
  tenantSchema,
  type Agent,
  type AgentTemplate,
  type AuditEvent,
  type AwsConnection,
  type Deployment,
  type Tenant,
  type TenantMembership
} from '@agent-launchpad/schemas';
import type { z } from 'zod';
import { controlPlaneKeys } from './keys.js';

type Item = Record<string, unknown>;

export class PersistenceValidationError extends Error {
  public constructor(entity: string) {
    super(`Persisted ${entity} record did not match its domain schema.`);
  }
}

function domain<T>(schema: z.ZodType<T>, item: Item, entity: string): T {
  const result = schema.safeParse(item);
  if (!result.success) throw new PersistenceValidationError(entity);
  return result.data;
}

export const fromPersistence = {
  tenant: (item: Item): Tenant => domain(tenantSchema, item, 'tenant'),
  membership: (item: Item): TenantMembership => domain(tenantMembershipSchema, item, 'membership'),
  awsConnection: (item: Item): AwsConnection => domain(awsConnectionSchema, item, 'AWS connection'),
  agent: (item: Item): Agent => domain(agentSchema, item, 'agent'),
  deployment: (item: Item): Deployment => domain(deploymentSchema, item, 'deployment'),
  auditEvent: (item: Item): AuditEvent => domain(auditEventSchema, item, 'audit event'),
  agentTemplate: (item: Item): AgentTemplate => domain(agentTemplateSchema, item, 'agent template')
};

export const toPersistence = {
  tenant(value: Tenant): Item {
    return {
      ...tenantSchema.parse(value),
      ...controlPlaneKeys.tenant(value.id),
      entityType: 'TENANT'
    };
  },
  membership(value: TenantMembership): Item {
    return {
      ...tenantMembershipSchema.parse(value),
      ...controlPlaneKeys.membership(value.tenantId, value.userId),
      ...controlPlaneKeys.userMemberships(value.userId),
      gsi1sk: `TENANT#${value.tenantId}`,
      entityType: 'MEMBERSHIP'
    };
  },
  awsConnection(value: AwsConnection): Item {
    return {
      ...awsConnectionSchema.parse(value),
      ...controlPlaneKeys.awsConnection(value.tenantId, value.id),
      entityType: 'AWS_CONNECTION'
    };
  },
  agent(value: Agent): Item {
    return {
      ...agentSchema.parse(value),
      ...controlPlaneKeys.agent(value.tenantId, value.id),
      entityType: 'AGENT'
    };
  },
  deployment(value: Deployment): Item {
    return {
      ...deploymentSchema.parse(value),
      ...controlPlaneKeys.deployment(value.tenantId, value.id),
      ...controlPlaneKeys.agentDeployments(value.tenantId, value.agentId),
      gsi2sk: `${value.createdAt}#${value.id}`,
      entityType: 'DEPLOYMENT'
    };
  },
  auditEvent(value: AuditEvent): Item {
    return {
      ...auditEventSchema.parse(value),
      ...controlPlaneKeys.audit(value.tenantId, value.createdAt, value.id),
      entityType: 'AUDIT_EVENT'
    };
  },
  agentTemplate(value: AgentTemplate): Item {
    return {
      ...agentTemplateSchema.parse(value),
      ...controlPlaneKeys.template(value.templateId, value.version),
      ...controlPlaneKeys.globalTemplates(),
      gsi1sk: `TEMPLATE#${value.templateId}#VERSION#${value.version}`,
      entityType: 'AGENT_TEMPLATE'
    };
  }
};
