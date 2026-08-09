import assert from 'node:assert/strict';
import test from 'node:test';
import type { ControlPlaneRepository } from '@agent-launchpad/aws';
import {
  customerSupportTemplate,
  type Agent,
  type AgentTemplate,
  type AwsConnection,
  type TenantContext
} from '@agent-launchpad/schemas';
import type { CustomerRoleAssumer } from '@agent-launchpad/aws';
import { ControlApi, type HttpRequest } from './http.js';

const tenantA = 'tnt_00000000-0000-4000-8000-000000000001';
const tenantB = 'tnt_00000000-0000-4000-8000-000000000002';
const agentId = 'agt_00000000-0000-4000-8000-000000000001';
const timestamp = '2026-01-01T00:00:00.000Z';
const template: AgentTemplate = customerSupportTemplate;
const agent: Agent = {
  id: agentId,
  tenantId: tenantA,
  templateId: template.templateId,
  templateVersion: '1',
  name: 'A',
  model: 'model',
  region: 'us-east-1',
  configuration: {
    configurationVersion: 1,
    template: { id: template.templateId, version: template.version },
    name: 'A',
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
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};
const verifiedConnection: AwsConnection = {
  id: 'awc_00000000-0000-4000-8000-000000000001',
  tenantId: tenantA,
  accountId: '123456789012',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole',
  externalId: 'test',
  status: 'VERIFIED',
  createdBy: 'user-a',
  createdAt: timestamp,
  updatedAt: timestamp
};
const agentInput = {
  name: 'x',
  templateId: template.templateId,
  templateVersion: '1',
  modelId: 'amazon.nova-lite-v1:0',
  awsConnectionId: verifiedConnection.id,
  capabilities: ['ORDER_LOOKUP'],
  guardrails: { refunds: { enabled: false } }
};

function request(route: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    requestId: 'request-1',
    route,
    method: route.slice(0, 3),
    user: { id: 'user-a', email: 'a@example.test' },
    ...overrides
  };
}

function repository(overrides: Partial<ControlPlaneRepository> = {}): ControlPlaneRepository {
  const context = (tenantId: string): TenantContext | undefined =>
    tenantId === tenantA ? { userId: 'user-a', tenantId, role: 'ADMIN' } : undefined;
  return {
    resolveTenantContext: async (userId: string, tenantId: string) =>
      userId === 'user-a' ? context(tenantId) : undefined,
    getAgent: async (tenantId: string, id: string) =>
      tenantId === tenantA && id === agentId ? agent : undefined,
    listAgents: async () => ({ items: [agent] }),
    getTenant: async (id: string) =>
      id === tenantA
        ? {
            id: tenantA,
            name: 'A',
            status: 'ACTIVE',
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt
          }
        : undefined,
    getAgentTemplate: async () => template,
    createAgentTemplate: async () => undefined,
    getAwsConnection: async () => verifiedConnection,
    createAgent: async () => undefined,
    appendAuditEvent: async () => undefined,
    listTenantContexts: async () => ({ items: [] }),
    ...overrides
  } as unknown as ControlPlaneRepository;
}

test('authenticated Cognito sub resolves tenant context and never reads another tenant partition', async () => {
  const api = new ControlApi(repository());
  const allowed = await api.handle(
    request('GET /tenants/{tenantId}/agents', { pathParameters: { tenantId: tenantA } })
  );
  assert.equal(allowed.statusCode, 200);
  const denied = await api.handle(
    request('GET /tenants/{tenantId}/agents', { pathParameters: { tenantId: tenantB } })
  );
  assert.equal(denied.statusCode, 403);
  assert.doesNotMatch(denied.body, /agt_/);
});

test('deployment launch is asynchronous, idempotent, and locked per agent', async () => {
  let idempotency: { deploymentId: string; requestHash: string } | undefined;
  let locked = false;
  let deployment: { id: string; status: string } | undefined;
  const api = new ControlApi(
    repository({
      listAgentArtifacts: async () => ({ items: [] }),
      getDeploymentByIdempotency: async () => idempotency,
      getDeploymentLock: async () => (locked ? { deploymentId: 'dep_existing' } : undefined),
      acquireDeploymentLock: async () => {
        locked = true;
      },
      createDeploymentIdempotency: async (value: { deploymentId: string; requestHash: string }) => {
        idempotency = value;
      },
      createDeployment: async (value: { id: string; status: string }) => {
        deployment = value;
      },
      getDeployment: async () =>
        deployment as unknown as Awaited<ReturnType<ControlPlaneRepository['getDeployment']>>,
      appendDeploymentEvent: async () => undefined,
      setDeploymentExecutionArn: async () => undefined
    }),
    () => new Date(timestamp),
    undefined,
    undefined,
    {
      start: async () => ({
        executionArn: 'arn:aws:states:us-east-1:123456789012:execution:deploy:dep'
      })
    }
  );
  const launch = await api.handle(
    request('POST /tenants/{tenantId}/agents/{agentId}/deploy', {
      pathParameters: { tenantId: tenantA, agentId },
      headers: { 'idempotency-key': 'deploy-1' }
    })
  );
  assert.equal(launch.statusCode, 202);
  assert.equal((JSON.parse(launch.body).data as { status: string }).status, 'QUEUED');
  const repeat = await api.handle(
    request('POST /tenants/{tenantId}/agents/{agentId}/deploy', {
      pathParameters: { tenantId: tenantA, agentId },
      headers: { 'idempotency-key': 'deploy-1' }
    })
  );
  assert.equal(repeat.statusCode, 202);
  assert.equal(
    deployment?.id,
    (JSON.parse(launch.body).data as { deploymentId: string }).deploymentId
  );
});

test('deployment detail is tenant-scoped and returns safe timeline and production metadata', async () => {
  const deployment = {
    id: 'dep_00000000-0000-4000-8000-000000000001',
    tenantId: tenantA,
    agentId,
    status: 'READY' as const,
    stage: 'READY' as const,
    requestedBy: 'user-a',
    configurationRevision: 1,
    snapshot: {
      templateId: template.templateId,
      templateVersion: template.version,
      awsConnectionId: verifiedConnection.id,
      accountId: verifiedConnection.accountId,
      region: verifiedConnection.region,
      modelId: 'amazon.nova-lite-v1:0',
      capabilities: ['ORDER_LOOKUP'],
      guardrails: { refunds: { enabled: false } }
    },
    idempotencyKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    executionArn: 'arn:aws:states:us-east-1:123456789012:execution:internal:secret',
    errorMessage: 'raw AWS exception must never reach the browser',
    createdAt: timestamp
  };
  const api = new ControlApi(
    repository({
      getDeployment: async (tenantId: string) =>
        tenantId === tenantA ? (deployment as never) : undefined,
      listDeploymentEvents: async () => ({
        items: [
          {
            id: 'dpe_00000000-0000-4000-8000-000000000001',
            tenantId: tenantA,
            deploymentId: deployment.id,
            toStage: 'READY' as const,
            status: 'READY' as const,
            createdAt: timestamp
          }
        ]
      }),
      listRuntimeVersions: async () => []
    })
  );
  const allowed = await api.handle(
    request('GET /tenants/{tenantId}/deployments/{deploymentId}', {
      pathParameters: { tenantId: tenantA, deploymentId: deployment.id }
    })
  );
  assert.equal(allowed.statusCode, 200);
  assert.doesNotMatch(allowed.body, /raw AWS exception|execution:internal|"requestHash"/);
  const denied = await api.handle(
    request('GET /tenants/{tenantId}/deployments/{deploymentId}', {
      pathParameters: { tenantId: tenantB, deploymentId: deployment.id }
    })
  );
  assert.equal(denied.statusCode, 403);
  assert.doesNotMatch(denied.body, /dep_/);
});

test('missing JWT identity and malformed request input use controlled errors with request IDs', async () => {
  const api = new ControlApi(repository());
  const unauthenticated = await api.handle({
    requestId: 'request-1',
    route: 'GET /tenants',
    method: 'GET'
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.match(unauthenticated.body, /request-1/);
  const invalid = await api.handle(
    request('GET /tenants/{tenantId}/agents', { pathParameters: { tenantId: 'not-an-id' } })
  );
  assert.equal(invalid.statusCode, 400);
});

test('tenant-scoped get conceals foreign resource IDs and suspended or removed memberships are denied', async () => {
  const api = new ControlApi(repository());
  const missing = await api.handle(
    request('GET /tenants/{tenantId}/agents/{agentId}', {
      pathParameters: { tenantId: tenantA, agentId: 'agt_00000000-0000-4000-8000-000000000099' }
    })
  );
  assert.equal(missing.statusCode, 404);
  const removed = new ControlApi(repository({ resolveTenantContext: async () => undefined }));
  assert.equal(
    (
      await removed.handle(
        request('GET /tenants/{tenantId}/agents', { pathParameters: { tenantId: tenantA } })
      )
    ).statusCode,
    403
  );
});

test('agent create rejects privileged fields and inactive/missing templates before metadata creation', async () => {
  const api = new ControlApi(repository());
  const privileged = await api.handle(
    request('POST /tenants/{tenantId}/agents', {
      pathParameters: { tenantId: tenantA },
      body: JSON.stringify({
        ...agentInput,
        tenantId: tenantB,
        status: 'READY'
      })
    })
  );
  assert.equal(privileged.statusCode, 400);
  const unavailable = new ControlApi(repository({ getAgentTemplate: async () => undefined }));
  const response = await unavailable.handle(
    request('POST /tenants/{tenantId}/agents', {
      pathParameters: { tenantId: tenantA },
      body: JSON.stringify({
        ...agentInput
      })
    })
  );
  assert.equal(response.statusCode, 404);
});

test('repository conflicts and unexpected errors are mapped without implementation detail', async () => {
  const conflict = new ControlApi(
    repository({
      createAgent: async () => {
        throw new Error('ConditionalCheckFailed');
      }
    })
  );
  const payload = JSON.stringify(agentInput);
  assert.equal(
    (
      await conflict.handle(
        request('POST /tenants/{tenantId}/agents', {
          pathParameters: { tenantId: tenantA },
          body: payload
        })
      )
    ).statusCode,
    409
  );
  const failure = new ControlApi(
    repository({
      listAgents: async () => {
        throw new Error('DynamoDB secret details');
      }
    })
  );
  const response = await failure.handle(
    request('GET /tenants/{tenantId}/agents', { pathParameters: { tenantId: tenantA } })
  );
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /DynamoDB secret details/);
});

test('AWS connection creation owns ExternalId and duplicate requests reuse its pending connection', async () => {
  let saved: AwsConnection | undefined;
  const api = new ControlApi(
    repository({
      createAwsConnection: async (value) => {
        if (saved) throw new Error('ConditionalCheckFailed');
        saved = value;
      },
      getAwsConnection: async (_tenantId, id) => (saved?.id === id ? saved : undefined)
    }),
    () => new Date(timestamp),
    {
      templateUrl: 'https://assets.example.test/bootstrap.json',
      trustedControlPlanePrincipalArn: 'arn:aws:iam::111111111111:role/ControlApi',
      allowedRegions: ['us-east-1']
    }
  );
  const input = JSON.stringify({ accountId: '123456789012', region: 'us-east-1' });
  const first = await api.handle(
    request('POST /tenants/{tenantId}/aws-connections', {
      pathParameters: { tenantId: tenantA },
      body: input
    })
  );
  const second = await api.handle(
    request('POST /tenants/{tenantId}/aws-connections', {
      pathParameters: { tenantId: tenantA },
      body: input
    })
  );
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(saved?.status, 'PENDING');
  assert.ok(saved?.externalId);
  assert.doesNotMatch(
    first.body.replace(/quickCreateUrl":"[^"]+/, ''),
    new RegExp(saved!.externalId)
  );
  assert.match(first.body, /console\.aws\.amazon\.com/);
  const injected = await api.handle(
    request('POST /tenants/{tenantId}/aws-connections', {
      pathParameters: { tenantId: tenantA },
      body: JSON.stringify({ accountId: '123456789012', region: 'us-east-1', status: 'VERIFIED' })
    })
  );
  assert.equal(injected.statusCode, 400);
});

test('verification uses assumed credentials in memory, validates identity, and writes verified audit state', async () => {
  const connection: AwsConnection = {
    id: 'awc_00000000-0000-5000-a000-000000000001',
    tenantId: tenantA,
    accountId: '123456789012',
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole',
    externalId: 'external-id',
    status: 'PENDING',
    bootstrapVersion: '1',
    createdBy: 'user-a',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const updates: unknown[] = [];
  const assumer: CustomerRoleAssumer = {
    assumeCustomerRole: async () => ({
      accessKeyId: 'temporary',
      secretAccessKey: 'temporary',
      sessionToken: 'temporary'
    }),
    getCallerIdentity: async () => ({
      account: connection.accountId,
      arn: 'arn:aws:sts::123456789012:assumed-role/AgentLaunchpadDeploymentRole/session'
    }),
    headArtifactBucket: async () => undefined
  };
  const api = new ControlApi(
    repository({
      getAwsConnection: async () => connection,
      startAwsConnectionVerification: async () => {
        updates.push('start');
      },
      completeAwsConnectionVerification: async (_tenant, _id, value) => {
        updates.push(value);
      }
    }),
    () => new Date(timestamp),
    undefined,
    assumer
  );
  const response = await api.handle(
    request('POST /tenants/{tenantId}/aws-connections/{connectionId}/verify', {
      pathParameters: { tenantId: tenantA, connectionId: connection.id },
      body: '{}'
    })
  );
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /VERIFIED/);
  assert.doesNotMatch(response.body, /temporary/);
  assert.equal((updates.at(-1) as AwsConnection).status, 'VERIFIED');
});
