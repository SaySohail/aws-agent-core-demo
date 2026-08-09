import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  ControlPlaneRepository,
  DynamoDbPersistenceClient,
  StsCustomerRoleAssumer
} from '@agent-launchpad/aws';
import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { ControlApi, type AuthenticatedUser } from './http.js';

const tableName = process.env.CONTROL_PLANE_TABLE_NAME;
if (!tableName) throw new Error('CONTROL_PLANE_TABLE_NAME must be configured.');

const repository = new ControlPlaneRepository(
  new DynamoDbPersistenceClient(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName)
);
const templateUrl = process.env.CUSTOMER_BOOTSTRAP_TEMPLATE_URL;
const trustedControlPlanePrincipalArn = process.env.CONTROL_API_EXECUTION_ROLE_ARN;
const allowedRegions = process.env.CUSTOMER_CONNECTION_ALLOWED_REGIONS?.split(',').filter(Boolean);
const deploymentStateMachineArn = process.env.DEPLOYMENT_STATE_MACHINE_ARN;
if (
  !templateUrl ||
  !trustedControlPlanePrincipalArn ||
  !allowedRegions?.length ||
  !deploymentStateMachineArn
)
  throw new Error('Customer AWS connection verification configuration is required.');
const workflowStarter = {
  async start(input: {
    deploymentId: string;
    tenantId: string;
    agentId: string;
    configurationRevision: number;
    artifactId?: string;
    operationType?: 'DEPLOY' | 'ROLLBACK' | 'UNDEPLOY';
  }) {
    const result = await new SFNClient({}).send(
      new StartExecutionCommand({
        stateMachineArn: deploymentStateMachineArn,
        name: `deployment-${input.deploymentId}`,
        input: JSON.stringify(input)
      })
    );
    if (!result.executionArn) throw new Error('Step Functions did not return an execution ARN.');
    return { executionArn: result.executionArn };
  }
};
const api = new ControlApi(
  repository,
  () => new Date(),
  { templateUrl, trustedControlPlanePrincipalArn, allowedRegions },
  new StsCustomerRoleAssumer(),
  workflowStarter
);

function authenticatedUser(
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0]
): AuthenticatedUser | undefined {
  const claims = event.requestContext.authorizer?.jwt.claims;
  const id = claims?.sub;
  if (typeof id !== 'string' || !id) return undefined;
  const email = claims.email;
  return { id, ...(typeof email === 'string' ? { email } : {}) };
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const user = authenticatedUser(event);
  return api.handle({
    requestId: event.requestContext.requestId,
    route: event.routeKey,
    method: event.requestContext.http.method,
    ...(event.pathParameters ? { pathParameters: event.pathParameters } : {}),
    ...(event.queryStringParameters ? { queryParameters: event.queryStringParameters } : {}),
    ...(event.body !== undefined ? { body: event.body } : {}),
    headers: event.headers,
    ...(user ? { user } : {})
  });
};
