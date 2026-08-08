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

async function startRuntime(server = createRuntimeServer()): Promise<RuntimeUnderTest> {
  await listen(server, 0);
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

async function requestJson(runtime: RuntimeUnderTest, path: string, init?: RequestInit) {
  const response = await fetch(`${runtime.baseUrl}${path}`, init);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

test('GET /ping reports a JSON Healthy status', async (context) => {
  const runtime = await startRuntime();
  context.after(() => runtime.close());

  const { response, body } = await requestJson(runtime, '/ping');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(body, { status: 'Healthy' });
});

test('POST /ping is rejected as a method not allowed', async (context) => {
  const runtime = await startRuntime();
  context.after(() => runtime.close());

  const { response, body } = await requestJson(runtime, '/ping', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.deepEqual(body, {
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' }
  });
});

test('POST /invocations trims a valid prompt and returns a deterministic result', async (context) => {
  const runtime = await startRuntime();
  context.after(() => runtime.close());

  const { response, body } = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '  hello  ' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { result: 'Agent Launchpad smoke runtime received: hello' });
});

test('invocations accept Unicode and remain stateless across requests', async (context) => {
  const runtime = await startRuntime();
  context.after(() => runtime.close());

  const first = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'こんにちは 🌍' })
  });
  const second = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'second request' })
  });

  assert.deepEqual(first.body, { result: 'Agent Launchpad smoke runtime received: こんにちは 🌍' });
  assert.deepEqual(second.body, {
    result: 'Agent Launchpad smoke runtime received: second request'
  });
});

for (const [name, payload, code] of [
  ['empty request body', '', 'INVALID_REQUEST'],
  ['missing prompt', JSON.stringify({}), 'INVALID_REQUEST'],
  ['non-string prompt', JSON.stringify({ prompt: 12 }), 'INVALID_REQUEST'],
  ['empty prompt', JSON.stringify({ prompt: '   ' }), 'INVALID_REQUEST'],
  ['malformed JSON', '{', 'INVALID_JSON']
] as const) {
  test(`invocations reject ${name}`, async (context) => {
    const runtime = await startRuntime();
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

test('invocations require JSON content and enforce the body limit', async (context) => {
  const runtime = await startRuntime();
  context.after(() => runtime.close());

  const nonJson = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"prompt":"hello"}'
  });
  assert.equal(nonJson.response.status, 400);
  assert.equal((nonJson.body.error as Record<string, unknown>).code, 'INVALID_REQUEST');

  const oversized = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a'.repeat(MAX_REQUEST_BODY_BYTES) })
  });
  assert.equal(oversized.response.status, 413);
  assert.equal((oversized.body.error as Record<string, unknown>).code, 'PAYLOAD_TOO_LARGE');
});

test('unknown routes and unsupported invocation methods are rejected', async (context) => {
  const runtime = await startRuntime();
  context.after(() => runtime.close());

  const unknown = await requestJson(runtime, '/missing');
  assert.equal(unknown.response.status, 404);
  assert.equal((unknown.body.error as Record<string, unknown>).code, 'NOT_FOUND');

  const method = await requestJson(runtime, '/invocations');
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST');
  assert.equal((method.body.error as Record<string, unknown>).code, 'METHOD_NOT_ALLOWED');
});

test('an invocation failure is sanitized and does not stop the runtime', async (context) => {
  const runtime = await startRuntime(
    createRuntimeServer({
      invoke: () => {
        throw new Error('sensitive implementation detail');
      }
    })
  );
  context.after(() => runtime.close());

  const failure = await requestJson(runtime, '/invocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' })
  });
  assert.equal(failure.response.status, 500);
  assert.deepEqual(failure.body, {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }
  });

  const health = await requestJson(runtime, '/ping');
  assert.equal(health.response.status, 200);
});

test('port parsing defaults to 8080 and rejects invalid configurations', () => {
  assert.equal(parsePort(undefined), 8080);
  assert.equal(parsePort('9090'), 9090);
  for (const value of ['0', '65536', '-1', 'not-a-port', '8080.5']) {
    assert.throws(() => parsePort(value), /PORT must be an integer/);
  }
});
