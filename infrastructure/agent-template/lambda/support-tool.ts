import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import {
  createSupportTicketInputSchema,
  getOrderInputSchema,
  processRefundInputSchema,
  searchOrdersInputSchema
} from '@agent-launchpad/schemas';

const tableName = process.env.SUPPORT_DATA_TABLE_NAME;
if (!tableName) throw new Error('SUPPORT_DATA_TABLE_NAME is required');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const prefix = (name: string) => name.split('___').at(-1);
type GatewayContext = {
  bedrockAgentCoreMessageVersion?: string;
  bedrockAgentCoreMcpMessageId?: string;
  bedrockAgentCoreGatewayId?: string;
  bedrockAgentCoreTargetId?: string;
  bedrockAgentCoreToolName?: string;
};
function invocation(context: GatewayContext, expected: string) {
  if (
    !context ||
    context.bedrockAgentCoreMessageVersion !== '1.0' ||
    !context.bedrockAgentCoreMcpMessageId ||
    !context.bedrockAgentCoreGatewayId ||
    !context.bedrockAgentCoreTargetId ||
    prefix(context.bedrockAgentCoreToolName ?? '') !== expected
  )
    return undefined;
  return context;
}
const failure = (code: string) => ({ success: false, code });

export const getOrder = async (event: unknown, context: GatewayContext) => {
  if (!invocation(context, 'get_order')) return failure('INVALID_INVOCATION_CONTRACT');
  const input = getOrderInputSchema.safeParse(event);
  if (!input.success) return failure('TOOL_VALIDATION_ERROR');
  try {
    const result = await db.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `ORDER#${input.data.orderId}`, SK: 'META' }
      })
    );
    const item = result.Item;
    if (!item) return { found: false };
    if (typeof item.orderId !== 'string' || typeof item.status !== 'string')
      return failure('MALFORMED_ORDER');
    return {
      found: true,
      order: {
        orderId: item.orderId,
        status: item.status,
        shippingCarrier: item.shippingCarrier,
        estimatedDelivery: item.estimatedDelivery
      }
    };
  } catch {
    return failure('TOOL_EXECUTION_ERROR');
  }
};

export const searchOrders = async (event: unknown, context: GatewayContext) => {
  if (!invocation(context, 'search_orders')) return failure('INVALID_INVOCATION_CONTRACT');
  const input = searchOrdersInputSchema.safeParse(event);
  if (!input.success) return failure('TOOL_VALIDATION_ERROR');
  try {
    const result = await db.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'OrdersByCustomer',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `CUSTOMER#${input.data.customerEmail.toLowerCase()}` },
        Limit: 10
      })
    );
    return {
      orders: (result.Items ?? []).flatMap((item) =>
        typeof item.orderId === 'string' && typeof item.status === 'string'
          ? [
              {
                orderId: item.orderId,
                status: item.status,
                shippingCarrier: item.shippingCarrier,
                estimatedDelivery: item.estimatedDelivery
              }
            ]
          : []
      )
    };
  } catch {
    return failure('TOOL_EXECUTION_ERROR');
  }
};

export const createSupportTicket = async (event: unknown, context: GatewayContext) => {
  const call = invocation(context, 'create_support_ticket');
  if (!call) return failure('INVALID_INVOCATION_CONTRACT');
  const input = createSupportTicketInputSchema.safeParse(event);
  if (!input.success) return failure('TOOL_VALIDATION_ERROR');
  const messageId = call.bedrockAgentCoreMcpMessageId!;
  const ticketId = `TKT-${messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `TICKET#${ticketId}`,
          SK: 'META',
          ticketId,
          status: 'OPEN',
          subject: input.data.subject,
          description: input.data.description,
          orderId: input.data.orderId,
          createdAt: new Date().toISOString(),
          idempotencyKey: messageId
        },
        ConditionExpression: 'attribute_not_exists(PK)'
      })
    );
    return { success: true, ticketId, status: 'OPEN' };
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException')
      return { success: true, ticketId, status: 'OPEN' };
    return failure('TOOL_EXECUTION_ERROR');
  }
};

/**
 * Deliberately fake/demo-only refund implementation. Authorization occurs in AgentCore Policy
 * before this handler; this transaction still enforces the independent order-value invariant.
 */
export const processRefund = async (event: unknown, context: GatewayContext) => {
  const call = invocation(context, 'process_refund');
  if (!call) return failure('INVALID_INVOCATION_CONTRACT');
  const input = processRefundInputSchema.safeParse(event);
  if (!input.success) return failure('TOOL_VALIDATION_ERROR');
  const messageId = call.bedrockAgentCoreMcpMessageId!;
  const refundId = `RFD-${messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;
  try {
    const orderResult = await db.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `ORDER#${input.data.orderId}`, SK: 'META' },
        ConsistentRead: true
      })
    );
    const order = orderResult.Item;
    if (
      !order ||
      typeof order.orderId !== 'string' ||
      typeof order.totalCents !== 'number' ||
      !Number.isSafeInteger(order.totalCents) ||
      typeof order.refundedCents !== 'number' ||
      !Number.isSafeInteger(order.refundedCents)
    )
      return failure(order ? 'MALFORMED_ORDER' : 'ORDER_NOT_FOUND');

    const createdAt = new Date().toISOString();
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                PK: `REFUND#${refundId}`,
                SK: 'META',
                GSI2PK: `ORDER#${input.data.orderId}`,
                GSI2SK: `REFUND#${createdAt}#${refundId}`,
                refundId,
                orderId: input.data.orderId,
                amountCents: input.data.amountCents,
                currency: input.data.currency,
                reason: input.data.reason,
                status: 'SUCCEEDED',
                createdAt,
                idempotencyKey: messageId,
                demoData: true
              },
              ConditionExpression: 'attribute_not_exists(PK)'
            }
          },
          {
            Update: {
              TableName: tableName,
              Key: { PK: `ORDER#${input.data.orderId}`, SK: 'META' },
              UpdateExpression: 'SET refundedCents = refundedCents + :amount',
              ConditionExpression: 'attribute_exists(PK) AND refundedCents <= totalCents - :amount',
              ExpressionAttributeValues: { ':amount': input.data.amountCents }
            }
          }
        ]
      })
    );
    console.log(
      JSON.stringify({
        event: 'policy_decision_observed',
        invocationId: messageId,
        tool: 'process_refund',
        decision: 'ALLOW',
        reasonCode: 'GATEWAY_POLICY_PERMITTED',
        amountCents: input.data.amountCents,
        policyProfile: 'refund-auto-approval-v1'
      })
    );
    return {
      success: true,
      refund: { refundId, orderId: input.data.orderId, status: 'SUCCEEDED' }
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionCanceledException') {
      try {
        const existing = await db.send(
          new GetCommand({ TableName: tableName, Key: { PK: `REFUND#${refundId}`, SK: 'META' } })
        );
        if (existing.Item?.refundId === refundId)
          return {
            success: true,
            refund: { refundId, orderId: input.data.orderId, status: 'SUCCEEDED' }
          };
      } catch {
        return failure('TOOL_EXECUTION_ERROR');
      }
      return failure('REFUND_EXCEEDS_REMAINING_VALUE');
    }
    return failure('TOOL_EXECUTION_ERROR');
  }
};
