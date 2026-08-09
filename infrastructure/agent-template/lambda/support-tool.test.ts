import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

process.env.SUPPORT_DATA_TABLE_NAME ??= 'demo-support-data';

const invocation = {
  bedrockAgentCoreMessageVersion: '1.0',
  bedrockAgentCoreMcpMessageId: 'refund-invocation-1',
  bedrockAgentCoreGatewayId: 'gateway-1',
  bedrockAgentCoreTargetId: 'target-1',
  bedrockAgentCoreToolName: 'ProcessRefundTarget___process_refund'
};
const input = {
  orderId: 'ORD-1023',
  amountCents: 10_000,
  currency: 'GBP' as const,
  reason: 'Damaged item'
};
const dbPrototype = DynamoDBDocumentClient.prototype as unknown as {
  send(command: unknown): Promise<unknown>;
};

test('same Gateway invocation ID persists at most one deterministic demo refund', async () => {
  const { processRefund } = await import('./support-tool.js');
  const original = dbPrototype.send;
  let transactions = 0;
  let refundPersisted = false;
  dbPrototype.send = async (command: unknown) => {
    if (command instanceof TransactWriteCommand) {
      transactions += 1;
      if (transactions === 1) {
        refundPersisted = true;
        return {};
      }
      throw Object.assign(new Error('duplicate'), { name: 'TransactionCanceledException' });
    }
    if (command instanceof GetCommand) {
      const key = (command.input.Key ?? {}) as { PK?: string };
      if (key.PK?.startsWith('ORDER#'))
        return { Item: { orderId: 'ORD-1023', totalCents: 15000, refundedCents: 0 } };
      return refundPersisted ? { Item: { refundId: 'RFD-refundinvocation1' } } : {};
    }
    throw new Error('Unexpected DynamoDB command');
  };
  try {
    const first = await processRefund(input, invocation);
    const retry = await processRefund(input, invocation);
    assert.deepEqual(first, {
      success: true,
      refund: { refundId: 'RFD-refundinvocation1', orderId: 'ORD-1023', status: 'SUCCEEDED' }
    });
    assert.deepEqual(retry, first);
    assert.equal(
      transactions,
      2,
      'the duplicate transaction is conditionally rejected, not persisted'
    );
  } finally {
    dbPrototype.send = original;
  }
});

test('refund domain invariant rejects a request that exceeds remaining order value', async () => {
  const { processRefund } = await import('./support-tool.js');
  const original = dbPrototype.send;
  dbPrototype.send = async (command: unknown) => {
    if (command instanceof GetCommand)
      return { Item: { orderId: 'ORD-1023', totalCents: 15000, refundedCents: 5000 } };
    if (command instanceof TransactWriteCommand)
      throw Object.assign(new Error('remaining value exceeded'), {
        name: 'TransactionCanceledException'
      });
    throw new Error('Unexpected DynamoDB command');
  };
  try {
    assert.deepEqual(await processRefund({ ...input, amountCents: 10_001 }, invocation), {
      success: false,
      code: 'REFUND_EXCEEDS_REMAINING_VALUE'
    });
  } finally {
    dbPrototype.send = original;
  }
});
