import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, AgentArtifact, AwsConnection, Deployment } from '@agent-launchpad/schemas';
import { customerSupportTemplate } from '@agent-launchpad/schemas';
import type { ControlPlaneRepository } from '@agent-launchpad/aws';
import { DeploymentArtifactPipeline } from './index.js';

const tenantId = 'tnt_00000000-0000-4000-8000-000000000001';
const agentId = 'agt_00000000-0000-4000-8000-000000000001';
const connection: AwsConnection = {
  id: 'awc_00000000-0000-4000-8000-000000000001',
  tenantId,
  accountId: '123456789012',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole',
  externalId: 'secret',
  status: 'VERIFIED',
  createdBy: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};
const agent: Agent = {
  id: agentId,
  tenantId,
  templateId: 'customer-support',
  templateVersion: '1',
  name: 'Mutable name',
  model: 'amazon.nova-lite-v1:0',
  region: 'us-east-1',
  configuration: {
    configurationVersion: 1,
    template: { id: 'customer-support', version: '1' },
    name: 'Mutable name',
    deploymentTarget: {
      awsConnectionId: connection.id,
      accountId: connection.accountId,
      region: connection.region
    },
    model: { modelId: 'amazon.nova-lite-v1:0' },
    capabilities: ['ORDER_SEARCH'],
    guardrails: { refunds: { enabled: false } }
  },
  revision: 2,
  status: 'DRAFT',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};
const deployment: Deployment = {
  id: 'dep_00000000-0000-4000-8000-000000000001',
  tenantId,
  agentId,
  operationType: 'DEPLOY',
  status: 'QUEUED',
  stage: 'QUEUED',
  requestedBy: 'user',
  configurationRevision: 1,
  snapshot: {
    templateId: 'customer-support',
    templateVersion: '1',
    awsConnectionId: connection.id,
    accountId: connection.accountId,
    region: connection.region,
    modelId: 'amazon.nova-lite-v1:0',
    capabilities: ['ORDER_LOOKUP'],
    guardrails: { refunds: { enabled: false } }
  },
  idempotencyKeyHash: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z'
};

test('artifact pipeline uses the immutable deployment snapshot and reuses the READY digest on retry', async () => {
  let artifact: AgentArtifact | undefined;
  let uploaded = 0;
  let builtCapabilities: readonly string[] = [];
  const repository = {
    getAgent: async () => agent,
    getAgentTemplate: async () => customerSupportTemplate,
    getAwsConnection: async () => connection,
    findAgentArtifactByDigest: async () => artifact,
    createAgentArtifact: async (value: AgentArtifact) => {
      artifact = value;
    },
    updateAgentArtifact: async (
      _tenantId: string,
      _id: string,
      changes: Partial<AgentArtifact>
    ) => {
      artifact = { ...artifact!, ...changes };
    },
    attachDeploymentArtifact: async (
      _tenantId: string,
      _id: string,
      artifactId: string,
      artifactSha256: string
    ) => {
      Object.assign(deployment.snapshot, { artifactId, artifactSha256 });
    }
  } as unknown as ControlPlaneRepository;
  const pipeline = new DeploymentArtifactPipeline({
    repository,
    builder: {
      build: async (snapshot: { agent: Agent }) => {
        builtCapabilities = snapshot.agent.configuration.capabilities;
        return {
          bytes: Buffer.from('zip'),
          sha256: 'c'.repeat(64),
          sizeBytes: 3,
          uncompressedSizeBytes: 3,
          runtime: 'NODE_22',
          entryPoint: ['opentelemetry-instrument', 'dist/app.js'],
          configurationVersion: 1,
          manifest: {}
        };
      }
    } as never,
    uploader: {
      upload: async () => {
        uploaded++;
        return {
          bucket: 'agent-launchpad-artifacts-123456789012-us-east-1',
          key: 'agents/key',
          versionId: 'version-1'
        };
      }
    } as never,
    now: () => new Date('2026-01-01T00:00:00.000Z')
  });
  await pipeline.ensure(deployment);
  await pipeline.ensure(deployment);
  assert.deepEqual(builtCapabilities, ['ORDER_LOOKUP']);
  assert.equal(uploaded, 1);
  assert.equal(artifact?.status, 'READY');
  assert.equal(deployment.snapshot.artifactSha256, 'c'.repeat(64));
});
