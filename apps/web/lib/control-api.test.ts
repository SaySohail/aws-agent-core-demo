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
