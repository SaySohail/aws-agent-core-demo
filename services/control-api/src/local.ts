import { createServer, type IncomingMessage } from 'node:http';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ControlPlaneRepository, DynamoDbPersistenceClient } from '@agent-launchpad/aws';
import type { Agent, AgentTemplate, Tenant, TenantMembership } from '@agent-launchpad/schemas';
import { ControlApi } from './http.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000';
const tableName = process.env.CONTROL_PLANE_TABLE_NAME ?? 'agent-launchpad-local';
const port = Number(process.env.CONTROL_API_PORT ?? 4000);
const at = '2026-08-08T00:00:00.000Z';
const tenantA = 'tnt_00000000-0000-4000-8000-000000000001';
const tenantB = 'tnt_00000000-0000-4000-8000-000000000002';
const templateId = 'tpl_00000000-0000-4000-8000-000000000001';
const agentId = 'agt_00000000-0000-4000-8000-000000000001';

function client() {
  return new DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
  });
}

function repository() {
  return new ControlPlaneRepository(
    new DynamoDbPersistenceClient(DynamoDBDocumentClient.from(client()), tableName)
  );
}

async function tableExists(): Promise<boolean> {
  try {
    await client().send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') return false;
    throw error;
  }
}

async function createTable(): Promise<void> {
  if (await tableExists()) return;
  await client().send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
        { AttributeName: 'gsi2pk', AttributeType: 'S' },
        { AttributeName: 'gsi2sk', AttributeType: 'S' }
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'MembershipsByUser',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        },
        {
          IndexName: 'DeploymentsByAgent',
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        }
      ]
    })
  );
}

async function ignoreConflict(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error) || !/ConditionalCheckFailed/.test(error.name)) throw error;
  }
}

async function seed(): Promise<void> {
  const repo = repository();
  const tenants: Tenant[] = [
    { id: tenantA, name: 'Tenant A', status: 'ACTIVE', createdAt: at, updatedAt: at },
    { id: tenantB, name: 'Tenant B', status: 'ACTIVE', createdAt: at, updatedAt: at }
  ];
  const memberships: TenantMembership[] = [
    { tenantId: tenantA, userId: 'user-a', role: 'ADMIN', createdAt: at },
    { tenantId: tenantB, userId: 'user-b', role: 'MEMBER', createdAt: at }
  ];
  const template: AgentTemplate = {
    templateId,
    version: '1',
    name: 'Customer support',
    status: 'ACTIVE'
  };
  const agents: Agent[] = [tenantA, tenantB].map((tenantId) => ({
    id: agentId,
    tenantId,
    templateId,
    templateVersion: '1',
    name: `Support agent ${tenantId === tenantA ? 'A' : 'B'}`,
    model: 'amazon.nova-lite-v1:0',
    region: 'us-east-1',
    status: 'DRAFT',
    createdAt: at,
    updatedAt: at
  }));
  for (const value of tenants) await ignoreConflict(() => repo.createTenant(value));
  for (const value of memberships) await ignoreConflict(() => repo.createMembership(value));
  await ignoreConflict(() => repo.createAgentTemplate(template));
  for (const value of agents) await ignoreConflict(() => repo.createAgent(value));
}

function route(
  method: string,
  pathname: string
): { route: string; pathParameters?: Record<string, string> } {
  const patterns: Array<[string, RegExp, string[]]> = [
    ['GET /health', /^\/health$/, []],
    ['GET /me', /^\/me$/, []],
    ['GET /tenants', /^\/tenants$/, []],
    ['GET /agent-templates', /^\/agent-templates$/, []],
    [
      'GET /agent-templates/{templateId}/versions/{version}',
      /^\/agent-templates\/([^/]+)\/versions\/([^/]+)$/,
      ['templateId', 'version']
    ],
    ['GET /tenants/{tenantId}', /^\/tenants\/([^/]+)$/, ['tenantId']],
    ['GET /tenants/{tenantId}/agents', /^\/tenants\/([^/]+)\/agents$/, ['tenantId']],
    ['POST /tenants/{tenantId}/agents', /^\/tenants\/([^/]+)\/agents$/, ['tenantId']],
    [
      'GET /tenants/{tenantId}/agents/{agentId}',
      /^\/tenants\/([^/]+)\/agents\/([^/]+)$/,
      ['tenantId', 'agentId']
    ],
    [
      'PATCH /tenants/{tenantId}/agents/{agentId}',
      /^\/tenants\/([^/]+)\/agents\/([^/]+)$/,
      ['tenantId', 'agentId']
    ],
    [
      'GET /tenants/{tenantId}/agents/{agentId}/deployments',
      /^\/tenants\/([^/]+)\/agents\/([^/]+)\/deployments$/,
      ['tenantId', 'agentId']
    ],
    [
      'GET /tenants/{tenantId}/aws-connections',
      /^\/tenants\/([^/]+)\/aws-connections$/,
      ['tenantId']
    ],
    [
      'GET /tenants/{tenantId}/aws-connections/{connectionId}',
      /^\/tenants\/([^/]+)\/aws-connections\/([^/]+)$/,
      ['tenantId', 'connectionId']
    ],
    ['GET /tenants/{tenantId}/deployments', /^\/tenants\/([^/]+)\/deployments$/, ['tenantId']],
    [
      'GET /tenants/{tenantId}/deployments/{deploymentId}',
      /^\/tenants\/([^/]+)\/deployments\/([^/]+)$/,
      ['tenantId', 'deploymentId']
    ]
  ];
  for (const [key, pattern, names] of patterns) {
    if (!key.startsWith(`${method} `)) continue;
    const match = pathname.match(pattern);
    if (match)
      return {
        route: key,
        ...(names.length
          ? {
              pathParameters: Object.fromEntries(
                names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])
              )
            }
          : {})
      };
  }
  return { route: `${method} /not-found` };
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error('Request body is too large.');
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body || undefined;
}

async function serve(): Promise<void> {
  if (process.env.NODE_ENV === 'production' || process.env.LOCAL_CONTROL_API !== '1')
    throw new Error(
      'Set LOCAL_CONTROL_API=1; the local header-based identity adapter is development-only.'
    );
  const api = new ControlApi(repository());
  const server = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', 'http://localhost:3000');
    response.setHeader(
      'access-control-allow-headers',
      'content-type,x-local-user-id,x-local-user-email'
    );
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const matched = route(request.method ?? 'GET', url.pathname);
      const userId = request.headers['x-local-user-id'];
      const body = await readBody(request);
      const result = await api.handle({
        requestId: crypto.randomUUID(),
        route: matched.route,
        method: request.method ?? 'GET',
        ...(matched.pathParameters ? { pathParameters: matched.pathParameters } : {}),
        queryParameters: Object.fromEntries(url.searchParams),
        ...(body ? { body } : {}),
        ...(typeof userId === 'string'
          ? {
              user: {
                id: userId,
                ...(typeof request.headers['x-local-user-email'] === 'string'
                  ? { email: request.headers['x-local-user-email'] }
                  : {})
              }
            }
          : {})
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Local adapter failed.',
            requestId: crypto.randomUUID()
          }
        })
      );
    }
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`Local control API listening on http://127.0.0.1:${port}`)
  );
}

const command = process.argv[2];
if (command === 'setup') {
  await createTable();
  await seed();
  console.log(`Seeded ${tableName} at ${endpoint}`);
} else if (command === 'reset') {
  if (await tableExists()) await client().send(new DeleteTableCommand({ TableName: tableName }));
  await createTable();
  await seed();
  console.log(`Reset and seeded ${tableName} at ${endpoint}`);
} else if (command === 'serve') await serve();
else throw new Error('Use local.ts setup, reset, or serve.');
