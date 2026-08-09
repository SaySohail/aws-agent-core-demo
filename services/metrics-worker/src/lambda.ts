import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ControlPlaneRepository, DynamoDbPersistenceClient, StsCustomerRoleAssumer } from '@agent-launchpad/aws';
import { CloudWatchAgentCoreMetricsReader } from './cloudwatch.js';
import { MetricsWorker } from './index.js';

const tableName = process.env.CONTROL_PLANE_TABLE_NAME;
if (!tableName) throw new Error('CONTROL_PLANE_TABLE_NAME must be configured.');
const worker = new MetricsWorker({
  repository: new ControlPlaneRepository(new DynamoDbPersistenceClient(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName)),
  assumer: new StsCustomerRoleAssumer(),
  reader: new CloudWatchAgentCoreMetricsReader(),
  report: (event, fields) => console.error(JSON.stringify({ event, ...fields }))
});
export async function handler() { return worker.collectAll(); }
