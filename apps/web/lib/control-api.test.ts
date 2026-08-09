import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlApiError, createControlApiClient } from './control-api';

test('the typed client centralizes authenticated agent requests and escapes path parameters', async () => {
  let received: Request | undefined;
  const api = createControlApiClient({
    baseUrl: 'https://control.example.test',
    getAccessToken: () => 'validated-cognito-jwt',
    fetch: async (input, init) => {
      received = new Request(input, init);
      return Response.json({ data: { id: 'agt_123' } });
    }
  });

  await api.agents.get('tnt_a/b', 'agt_123');

  assert.equal(received?.url, 'https://control.example.test/tenants/tnt_a%2Fb/agents/agt_123');
  assert.equal(received?.headers.get('authorization'), 'Bearer validated-cognito-jwt');
});

test('the typed client returns the API error contract including its request ID', async () => {
  const api = createControlApiClient({
    baseUrl: 'https://control.example.test/',
    getAccessToken: () => null,
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Tenant membership is required.',
            requestId: 'request-123'
          }
        },
        { status: 403 }
      )
  });

  await assert.rejects(
    () => api.tenants.get('tnt_123'),
    (error: unknown) =>
      error instanceof ControlApiError &&
      error.status === 403 &&
      error.body.code === 'FORBIDDEN' &&
      error.body.requestId === 'request-123'
  );
});

test('deployment retries use only the authenticated control-plane API and carry an idempotency key', async () => {
  let received: Request | undefined;
  const api = createControlApiClient({
    baseUrl: 'https://control.example.test',
    getAccessToken: () => 'validated-cognito-jwt',
    fetch: async (input, init) => {
      received = new Request(input, init);
      return Response.json({ data: { deploymentId: 'dep_123', status: 'QUEUED' } });
    }
  });
  await api.deployments.retry('tnt_123', 'dep_123', 'retry-123');
  assert.equal(
    received?.url,
    'https://control.example.test/tenants/tnt_123/deployments/dep_123/retry'
  );
  assert.equal(received?.method, 'POST');
  assert.equal(received?.headers.get('idempotency-key'), 'retry-123');
  assert.equal(received?.headers.get('authorization'), 'Bearer validated-cognito-jwt');
});

test('version history uses the tenant-scoped endpoint and retains opaque pagination', async () => {
  let received: Request | undefined;
  const api = createControlApiClient({
    baseUrl: 'https://control.example.test',
    getAccessToken: () => 'validated-cognito-jwt',
    fetch: async (input, init) => {
      received = new Request(input, init);
      return Response.json({ data: [], page: { nextToken: 'opaque-token' } });
    }
  });

  const result = await api.agents.versions('tnt_123', 'agt_123', { pageSize: 25 });
  assert.equal(
    received?.url,
    'https://control.example.test/tenants/tnt_123/agents/agt_123/versions?pageSize=25'
  );
  assert.equal(result.page?.nextToken, 'opaque-token');
});

test('rollback sends only the selected version and an idempotency key', async () => {
  let received: Request | undefined;
  const api = createControlApiClient({
    baseUrl: 'https://control.example.test',
    getAccessToken: () => 'validated-cognito-jwt',
    fetch: async (input, init) => {
      received = new Request(input, init);
      return Response.json({ data: { deploymentId: 'dep_rollback', status: 'QUEUED' } });
    }
  });

  await api.agents.rollback('tnt_123', 'agt_123', '2', 'rollback-123');
  assert.equal(
    received?.url,
    'https://control.example.test/tenants/tnt_123/agents/agt_123/rollback'
  );
  assert.equal(received?.headers.get('idempotency-key'), 'rollback-123');
  assert.deepEqual(await received?.json(), { targetRuntimeVersion: '2' });
});
