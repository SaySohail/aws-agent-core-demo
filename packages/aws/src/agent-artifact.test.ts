import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customerSupportTemplate, type Agent, type AwsConnection } from '@agent-launchpad/schemas';
import {
  ADOT_PACKAGE,
  ADOT_PACKAGE_VERSION,
  AGENT_ARTIFACT_ENTRY_POINT,
  AgentArtifactBuilder,
  AgentArtifactError,
  AgentArtifactUploader,
  sha256
} from './agent-artifact.js';
import { customerArtifactKmsKeyArn } from './customer-connection.js';

const tenantId = 'tnt_12345678-1234-4234-8234-123456789abc';
const agentId = 'agt_12345678-1234-4234-8234-123456789abc';
const connection: AwsConnection = {
  id: 'awc_12345678-1234-4234-8234-123456789abc',
  tenantId,
  accountId: '123456789012',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole',
  externalId: 'not-packaged',
  status: 'VERIFIED',
  createdBy: 'test',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};
function agent(name = 'Support', includeSearch = false): Agent {
  return {
    id: agentId,
    tenantId,
    templateId: 'customer-support',
    templateVersion: '1',
    name,
    model: 'amazon.nova-lite-v1:0',
    region: 'us-east-1',
    configuration: {
      configurationVersion: 1,
      template: { id: 'customer-support', version: '1' },
      name,
      deploymentTarget: {
        awsConnectionId: connection.id,
        accountId: connection.accountId,
        region: connection.region
      },
      model: { modelId: 'amazon.nova-lite-v1:0' },
      capabilities: includeSearch ? ['ORDER_LOOKUP', 'ORDER_SEARCH'] : ['ORDER_LOOKUP'],
      guardrails: { refunds: { enabled: false } }
    },
    revision: 1,
    status: 'DRAFT',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}
const builder = new AgentArtifactBuilder(
  join(process.cwd(), '../../agents/customer-support/src/app.ts')
);

test('build is byte reproducible and configuration changes affect the digest', async () => {
  const first = await builder.build({
    agent: agent(),
    template: customerSupportTemplate,
    connection
  });
  const second = await builder.build({
    agent: agent(),
    template: customerSupportTemplate,
    connection
  });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sha256, sha256(first.bytes));
  const changed = await builder.build({
    agent: agent('Support', true),
    template: customerSupportTemplate,
    connection
  });
  assert.notEqual(changed.sha256, first.sha256);
  const paths = zipPaths(first.bytes);
  assert.ok(paths.includes('config/agent-config.json'));
  assert.ok(paths.includes('dist/app.js'));
  assert.ok(paths.includes('dist/adot-register.cjs'));
  assert.ok(paths.includes('node_modules/.bin/opentelemetry-instrument'));
  assert.deepEqual(first.entryPoint, AGENT_ARTIFACT_ENTRY_POINT);
  assert.deepEqual(first.manifest.entryPoint, AGENT_ARTIFACT_ENTRY_POINT);
  assert.deepEqual(first.manifest.observability, {
    adotPackage: ADOT_PACKAGE,
    adotPackageVersion: ADOT_PACKAGE_VERSION
  });
  assert.equal(first.manifest.runtime, 'NODE_22');
  assert.ok(!first.bytes.toString('utf8').includes('not-packaged'));
  assert.ok(
    paths.every(
      (path) =>
        !/(^|\/)\.git(?:\/|$)|(^|\/)\.env(?:$|\.)|(^|\/)(?:test|tests|fixtures)(?:\/|$)|\.(?:node|so)$/i.test(
          path
        )
    )
  );
});

test('uploader requires VersionId, explicitly selects the bootstrap KMS key, and resumes an uploaded object', async () => {
  const writes: unknown[] = [];
  const uploader = new AgentArtifactUploader(
    {
      assumeCustomerRole: async () => ({
        accessKeyId: 'a',
        secretAccessKey: 'b',
        sessionToken: 'c'
      }),
      getCallerIdentity: async () => ({ account: connection.accountId }),
      headArtifactBucket: async () => undefined
    },
    () => ({
      head: async () => {
        throw new Error('NotFound');
      },
      put: async (input) => {
        writes.push(input);
        return { versionId: 'version-1', etag: 'etag-1' };
      }
    })
  );
  const result = await uploader.upload({
    tenantId,
    agentId,
    sha256: 'a'.repeat(64),
    configurationVersion: 1,
    templateVersion: '1',
    bytes: Buffer.from('zip'),
    connection
  });
  assert.equal(result.versionId, 'version-1');
  assert.deepEqual(writes, [
    {
      bucket: 'agent-launchpad-artifacts-123456789012-us-east-1',
      key: `agents/${agentId}/artifacts/${'a'.repeat(64)}/agent.zip`,
      expectedOwner: connection.accountId,
      bytes: Buffer.from('zip'),
      kmsKeyId: customerArtifactKmsKeyArn(connection.accountId, connection.region),
      metadata: {
        sha256: 'a'.repeat(64),
        agentid: agentId,
        templateversion: '1',
        configurationversion: '1'
      }
    }
  ]);
  const noVersion = new AgentArtifactUploader(
    {
      assumeCustomerRole: async () => ({
        accessKeyId: 'a',
        secretAccessKey: 'b',
        sessionToken: 'c'
      }),
      getCallerIdentity: async () => ({ account: connection.accountId }),
      headArtifactBucket: async () => undefined
    },
    () => ({
      head: async () => {
        throw new Error('NotFound');
      },
      put: async () => ({})
    })
  );
  await assert.rejects(
    noVersion.upload({
      tenantId,
      agentId,
      sha256: 'b'.repeat(64),
      configurationVersion: 1,
      templateVersion: '1',
      bytes: Buffer.from('zip'),
      connection
    }),
    (cause: unknown) =>
      cause instanceof AgentArtifactError && cause.code === 'S3_VERSION_ID_REQUIRED'
  );
});

test('extracted package starts and responds to ping', async () => {
  const artifact = await builder.build({
    agent: agent(),
    template: customerSupportTemplate,
    connection
  });
  const directory = await mkdtemp(join(tmpdir(), 'agent-artifact-smoke-'));
  for (const entry of zipEntries(artifact.bytes)) {
    await mkdir(join(directory, entry.path, '..'), { recursive: true });
    await writeFile(join(directory, entry.path), entry.data);
  }
  const port = 51899;
  const child = spawn(process.execPath, ['--require', './dist/adot-register.cjs', 'dist/app.js'], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      AWS_REGION: 'us-east-1',
      BEDROCK_MODEL_ID: 'test',
      AGENT_GATEWAY_URL: 'http://127.0.0.1:9'
    },
    stdio: 'ignore'
  });
  try {
    await waitForPing(port);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

function zipEntries(zip: Buffer): { path: string; data: Buffer }[] {
  const values: { path: string; data: Buffer }[] = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 22),
      name = zip.readUInt16LE(offset + 26);
    const path = zip.subarray(offset + 30, offset + 30 + name).toString('utf8');
    const start = offset + 30 + name + zip.readUInt16LE(offset + 28);
    values.push({ path, data: zip.subarray(start, start + size) });
    offset = start + size;
  }
  return values;
}
function zipPaths(zip: Buffer): string[] {
  return zipEntries(zip).map((entry) => entry.path);
}
async function waitForPing(port: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const result = await new Promise<number>((resolve, reject) => {
        const value = request(`http://127.0.0.1:${port}/ping`, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        value.on('error', reject);
        value.end();
      });
      if (result === 200) return;
    } catch {
      /* process is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Packaged runtime did not become healthy.');
}
