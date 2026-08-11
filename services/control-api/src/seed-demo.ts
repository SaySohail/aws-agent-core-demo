import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { pathToFileURL } from 'node:url';
import { ControlPlaneRepository, DynamoDbPersistenceClient } from '@agent-launchpad/aws';
import {
  customerSupportTemplate,
  tenantMembershipSchema,
  type Tenant,
  type TenantMembership
} from '@agent-launchpad/schemas';

const demoTenantId = 'tnt_6cb31f77-33ac-4b28-841f-68e60f744b9d';
const demoTenantName = 'Demo Tenant';

type DemoSeedRepository = Pick<
  ControlPlaneRepository,
  'createTenant' | 'getTenant' | 'createMembership' | 'getMembership' | 'createAgentTemplate'
>;

export interface DemoSeedConfig {
  readonly tableName: string;
  readonly region: string;
  readonly userId: string;
}

export class DemoSeedConfigurationError extends Error {}

export function readDemoSeedConfig(environment: NodeJS.ProcessEnv): DemoSeedConfig {
  const tableName = requiredEnvironment(environment, 'CONTROL_PLANE_TABLE_NAME');
  const region = requiredEnvironment(environment, 'AWS_REGION');
  const userId = requiredEnvironment(environment, 'DEMO_USER_SUB');
  if (!tenantMembershipSchema.shape.userId.safeParse(userId).success)
    throw new DemoSeedConfigurationError('DEMO_USER_SUB is invalid.');
  return { tableName, region, userId };
}

export async function seedDemo(
  repository: DemoSeedRepository,
  config: Pick<DemoSeedConfig, 'userId'>,
  now: () => Date = () => new Date()
): Promise<{ tenantId: string; templateId: string; templateVersion: string }> {
  const timestamp = now().toISOString();
  const tenant: Tenant = {
    id: demoTenantId,
    name: demoTenantName,
    status: 'ACTIVE',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const membership: TenantMembership = {
    tenantId: demoTenantId,
    userId: config.userId,
    role: 'ADMIN',
    createdAt: timestamp
  };

  await ensureTenant(repository, tenant);
  await ensureMembership(repository, membership);
  await ensureTemplate(repository);

  return {
    tenantId: demoTenantId,
    templateId: customerSupportTemplate.templateId,
    templateVersion: customerSupportTemplate.version
  };
}

async function ensureTenant(repository: DemoSeedRepository, expected: Tenant): Promise<void> {
  const existing = await repository.getTenant(expected.id);
  if (existing) return assertTenant(existing, expected);
  try {
    await repository.createTenant(expected);
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
  }
  const persisted = await repository.getTenant(expected.id);
  if (!persisted) throw new Error('Demo tenant could not be confirmed after creation.');
  assertTenant(persisted, expected);
}

async function ensureMembership(
  repository: DemoSeedRepository,
  expected: TenantMembership
): Promise<void> {
  const existing = await repository.getMembership(expected.tenantId, expected.userId);
  if (existing) return assertMembership(existing);
  try {
    await repository.createMembership(expected);
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
  }
  const persisted = await repository.getMembership(expected.tenantId, expected.userId);
  if (!persisted) throw new Error('Demo membership could not be confirmed after creation.');
  assertMembership(persisted);
}

async function ensureTemplate(repository: DemoSeedRepository): Promise<void> {
  try {
    await repository.createAgentTemplate(customerSupportTemplate);
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
  }
}

function assertTenant(actual: Tenant, expected: Tenant): void {
  if (actual.name !== expected.name || actual.status !== 'ACTIVE')
    throw new Error('Existing demo tenant does not match the required active demo tenant.');
}

function assertMembership(actual: TenantMembership): void {
  if (actual.role !== 'ADMIN')
    throw new Error('Existing demo membership does not have the required administrator role.');
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new DemoSeedConfigurationError(`${name} must be configured.`);
  return value;
}

function isConditionalConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

export function demoSeedFailureMessage(error: unknown): string {
  if (error instanceof DemoSeedConfigurationError) return error.message;
  if (error instanceof Error && ['ExpiredToken', 'ExpiredTokenException'].includes(error.name))
    return 'AWS session expired. Reauthenticate and retry.';
  if (
    error instanceof Error &&
    ['CredentialsProviderError', 'UnrecognizedClientException', 'InvalidClientTokenId'].includes(
      error.name
    )
  )
    return 'AWS credentials are unavailable or invalid. Reauthenticate and retry.';
  if (error instanceof Error && error.name === 'AccessDeniedException')
    return 'AWS access was denied. Verify DynamoDB permissions and retry.';
  if (error instanceof Error && error.name === 'ResourceNotFoundException')
    return 'Control-plane table was not found in the configured AWS Region.';
  return 'Demo seeding failed. Review the required configuration and AWS permissions.';
}

async function main(): Promise<void> {
  const config = readDemoSeedConfig(process.env);
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const repository = new ControlPlaneRepository(
    new DynamoDbPersistenceClient(documentClient, config.tableName)
  );
  const seeded = await seedDemo(repository, config);
  console.log(`Seeded demo tenant ${seeded.tenantId} and template ${seeded.templateId}@${seeded.templateVersion}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(demoSeedFailureMessage(error));
    process.exitCode = 1;
  }
}
