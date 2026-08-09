import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayToolExecutor } from './gateway-tool-executor.js';
import { GatewayMcpError } from './gateway-mcp-client.js';
import { expectedGatewayToolNames } from './gateway-tool-names.js';
import type { GatewayMcpClient } from './gateway-mcp-client.js';

test('discovers target-prefixed tools once and preserves the supplied request ID', async () => {
  const calls: unknown[] = [];
  const client: GatewayMcpClient = {
    listTools: async () => Object.values(expectedGatewayToolNames()).map((name) => ({ name })),
    callTool: async (input) => {
      calls.push(input);
      return { found: true };
    }
  };
  const executor = new GatewayToolExecutor(client);
  assert.deepEqual(
    await executor.execute({
      name: 'get_order',
      input: { orderId: 'ORD-1023' },
      requestId: 'bedrock-use-1'
    }),
    { status: 'success', data: { found: true } }
  );
  const call = calls[0] as { name: string; arguments: unknown; requestId: string };
  assert.deepEqual(
    { name: call.name, arguments: call.arguments, requestId: call.requestId },
    {
      name: 'GetOrderTarget___get_order',
      arguments: { orderId: 'ORD-1023' },
      requestId: 'bedrock-use-1'
    }
  );
});

test('fails closed when a required gateway tool is missing', async () => {
  const client: GatewayMcpClient = { listTools: async () => [], callTool: async () => ({}) };
  const result = await new GatewayToolExecutor(client).execute({
    name: 'get_order',
    input: { orderId: 'ORD-1023' }
  });
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.equal(result.code, 'GATEWAY_TOOL_NOT_AVAILABLE');
});

test('keeps Gateway authorization failures separate from tool and order failures', async () => {
  const client: GatewayMcpClient = {
    listTools: async () => Object.values(expectedGatewayToolNames()).map((name) => ({ name })),
    callTool: async () => {
      throw new GatewayMcpError('GATEWAY_UNAUTHORIZED');
    }
  };
  const result = await new GatewayToolExecutor(client).execute({
    name: 'get_order',
    input: { orderId: 'ORD-1023' }
  });
  assert.deepEqual(result, {
    status: 'error',
    code: 'GATEWAY_UNAUTHORIZED',
    message: 'The support service could not complete the request.'
  });
});
