import assert from 'node:assert/strict';
import test from 'node:test';
import type { Server } from 'node:http';
import {
  closeServer,
  createRuntimeServer,
  listen,
  MAX_REQUEST_BODY_BYTES,
  parsePort
} from './server.js';

interface RuntimeUnderTest {
  readonly server: Server;
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startRuntime(server: Server): Promise<RuntimeUnderTest> {
  await listen(server, 0);
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, close: () => closeServer(server) };
}

async function requestJson(runtime: RuntimeUnderTest, path: string, init?: RequestInit) {
  const response = await fetch(`${runtime.baseUrl}${path}`, init);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

test('GET /ping remains cheap and healthy', async (context) => {
  const runtime = await startRuntime(createRuntimeServer());
  context.after(() => runtime.close());
  const { response, body } = await requestJson(runtime, '/ping');
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'Healthy' });
});

test('POST /invocations preserves the result envelope and trims prompts', async (context) => {
  let prompt: string | undefined;
  const runtime = await startRuntime(
    createRuntimeServer({ invoke: (value) => ((prompt = value), 'Support response') })
  );
  context.after(() => runtime.close());
  const { response, body } = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '  hello  ' })
  });
  assert.equal(response.status, 200);
  assert.equal(prompt, 'hello');
  assert.deepEqual(body, { result: 'Support response' });
});

for (const [name, payload, code] of [
  ['empty request body', '', 'INVALID_REQUEST'],
  ['missing prompt', JSON.stringify({}), 'INVALID_REQUEST'],
  ['non-string prompt', JSON.stringify({ prompt: 12 }), 'INVALID_REQUEST'],
  ['empty prompt', JSON.stringify({ prompt: '   ' }), 'INVALID_REQUEST'],
  ['malformed JSON', '{', 'INVALID_JSON']
] as const) {
  test(`invocations reject ${name}`, async (context) => {
    const runtime = await startRuntime(createRuntimeServer());
    context.after(() => runtime.close());
    const { response, body } = await requestJson(runtime, '/invocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    assert.equal(response.status, 400);
    assert.equal((body.error as Record<string, unknown>).code, code);
  });
}

test('routing, content type, body size, and methods are still bounded', async (context) => {
  const runtime = await startRuntime(createRuntimeServer());
  context.after(() => runtime.close());
  const wrongMethod = await requestJson(runtime, '/invocations');
  assert.equal(wrongMethod.response.status, 405);
  const unknown = await requestJson(runtime, '/missing');
  assert.equal(unknown.response.status, 404);
  const nonJson = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"prompt":"hello"}'
  });
  assert.equal(nonJson.response.status, 400);
  const oversized = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a'.repeat(MAX_REQUEST_BODY_BYTES) })
  });
  assert.equal(oversized.response.status, 413);
});

test('safe agent failures and unexpected failures remain sanitized', async (context) => {
  const safe = Object.assign(new Error('safe'), { code: 'MODEL_TIMEOUT' });
  const runtime = await startRuntime(
    createRuntimeServer({
      invoke: () => {
        throw safe;
      }
    })
  );
  context.after(() => runtime.close());
  const { response, body } = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' })
  });
  assert.equal(response.status, 504);
  assert.equal((body.error as Record<string, unknown>).code, 'MODEL_TIMEOUT');
});

test('port parsing is retained', () => {
  assert.equal(parsePort(undefined), 8080);
  assert.equal(parsePort('9090'), 9090);
  assert.throws(() => parsePort('0'), /PORT must be an integer/);
});
