import assert from 'node:assert/strict';
import test from 'node:test';
import type { ControlPlaneRepository } from '@agent-launchpad/aws';
import type { Agent, AgentTemplate, TenantContext } from '@agent-launchpad/schemas';
import { ControlApi, type HttpRequest } from './http.js';

const tenantA = 'tnt_00000000-0000-4000-8000-000000000001';
const tenantB = 'tnt_00000000-0000-4000-8000-000000000002';
const agentId = 'agt_00000000-0000-4000-8000-000000000001';
const template: AgentTemplate = {
  templateId: 'tpl_00000000-0000-4000-8000-000000000001',
  version: '1',
  name: 'Template',
  status: 'ACTIVE'
};
const agent: Agent = {
  id: agentId,
  tenantId: tenantA,
  templateId: template.templateId,
  templateVersion: '1',
  name: 'A',
  model: 'model',
  region: 'us-east-1',
  status: 'DRAFT',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
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
        name: 'x',
        templateId: template.templateId,
        templateVersion: '1',
        model: 'm',
        region: 'us-east-1',
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
        name: 'x',
        templateId: template.templateId,
        templateVersion: '1',
        model: 'm',
        region: 'us-east-1'
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
  const payload = JSON.stringify({
    name: 'x',
    templateId: template.templateId,
    templateVersion: '1',
    model: 'm',
    region: 'us-east-1'
  });
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
