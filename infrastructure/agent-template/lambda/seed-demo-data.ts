import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** CloudFormation invokes this only to maintain deterministic, explicitly fake demo data. */
export const handler = async (event: {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: { tableName: string };
}) => {
  if (event.RequestType !== 'Delete') {
    await db.send(
      new PutCommand({
        TableName: event.ResourceProperties.tableName,
        Item: {
          PK: 'ORDER#ORD-1023',
          SK: 'META',
          GSI1PK: 'CUSTOMER#demo.customer@example.test',
          GSI1SK: 'ORDER#2026-01-15T10:00:00.000Z#ORD-1023',
          orderId: 'ORD-1023',
          customerEmail: 'demo.customer@example.test',
          status: 'IN_TRANSIT',
          shippingCarrier: 'DemoShip',
          estimatedDelivery: '2026-01-20',
          demoData: true
        }
      })
    );
  }
  return { PhysicalResourceId: 'agent-launchpad-demo-order-ORD-1023' };
};
