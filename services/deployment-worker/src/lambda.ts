import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ControlPlaneRepository,
  DynamoDbPersistenceClient,
  StsCustomerRoleAssumer,
  AgentArtifactBuilder,
  AgentArtifactUploader
} from '@agent-launchpad/aws';
import type { DeploymentStage } from '@agent-launchpad/schemas';
import { AgentCoreRuntimeDeploymentPort } from './agentcore-runtime.js';
import {
  CatalogBedrockPreflightChecker,
  DeploymentArtifactPipeline,
  DeploymentWorker,
  type DeploymentCommandInput
} from './index.js';

const tableName = process.env.CONTROL_PLANE_TABLE_NAME;
if (!tableName) throw new Error('CONTROL_PLANE_TABLE_NAME must be configured.');
const repository = new ControlPlaneRepository(
  new DynamoDbPersistenceClient(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName)
);
const assumer = new StsCustomerRoleAssumer();
const worker = new DeploymentWorker({
  repository,
  customerRoleAssumer: assumer,
  bedrock: new CatalogBedrockPreflightChecker(),
  // Dependency stacks are reconciled by SAY-99's injected provisioner. This Lambda does not
  // re-provision them while executing runtime work.
  dependencies: {
    reconcile: async () => 'READY',
    getStatus: async () => 'READY',
    compensate: async () => {}
  },
  artifactPipeline: new DeploymentArtifactPipeline({
    repository,
    builder: new AgentArtifactBuilder(
      process.env.AGENT_RUNTIME_SOURCE_PATH ?? '/var/task/runtime-source/app.ts'
    ),
    uploader: new AgentArtifactUploader(assumer),
    now: () => new Date()
  }),
  runtime: new AgentCoreRuntimeDeploymentPort(repository, assumer),
  undeployRuntime: new AgentCoreRuntimeDeploymentPort(repository, assumer)
});

export async function handler(event: DeploymentCommandInput & { stage: DeploymentStage }) {
  if (!event?.stage) throw new Error('Deployment stage is required.');
  return worker.dispatch(event.stage, event);
}
