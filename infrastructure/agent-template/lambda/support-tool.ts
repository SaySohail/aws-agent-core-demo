import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} from '@aws-sdk/lib-dynamodb';
import {
  createSupportTicketInputSchema,
  getOrderInputSchema,
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
