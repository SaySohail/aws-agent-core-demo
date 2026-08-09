import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customerSupportTemplate, type Agent, type AwsConnection } from '@agent-launchpad/schemas';
import { AgentArtifactBuilder, sha256 } from './agent-artifact.js';

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
  assert.deepEqual(zipPaths(first.bytes), [
    'config/agent-config.json',
    'dist/app.js',
    'manifest.json'
  ]);
  assert.equal(first.manifest.entryPoint, 'dist/app.js');
  assert.equal(first.manifest.runtime, 'NODE_22');
  assert.ok(!first.bytes.toString('utf8').includes('not-packaged'));
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
  const child = spawn(process.execPath, ['dist/app.js'], {
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
