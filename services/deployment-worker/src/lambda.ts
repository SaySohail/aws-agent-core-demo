import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ControlPlaneRepository,
  DynamoDbPersistenceClient,
  StsCustomerRoleAssumer,
  AgentArtifactBuilder,
  AgentArtifactUploader
} from '@agent-launchpad/aws';
import type { DeploymentStage } from '@agent-launchpad/schemas';
import { AgentCoreRuntimeDeploymentPort } from './agentcore-runtime.js';
import { CloudFormationDependencyProvisioner } from './dependencies.js';
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
const dependencyProvisioner = new CloudFormationDependencyProvisioner(
  repository,
  assumer,
  process.env.AGENT_DEPENDENCY_TEMPLATE_URL,
  (input) => new CloudFormationClient(input)
);
const artifactCleanup = {
  async deleteExactVersions(input: DeploymentCommandInput) {
    const deployment = await repository.getDeployment(input.tenantId, input.deploymentId);
    const connection =
      deployment &&
      (await repository.getAwsConnection(input.tenantId, deployment.snapshot.awsConnectionId));
    if (
      !deployment ||
      deployment.operationType !== 'UNDEPLOY' ||
      !connection ||
      connection.status !== 'VERIFIED'
    )
      throw new Error('Trusted artifact cleanup context is unavailable.');
    const credentials = await assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `cleanup-${deployment.id}`
    });
    const s3 = new S3Client({ region: connection.region, credentials });
    const artifacts = (
      await repository.listAgentArtifacts(input.tenantId, { limit: 100 })
    ).items.filter(
      (artifact) =>
        deployment.cleanupPlan?.artifactIds.includes(artifact.id) &&
        artifact.agentId === input.agentId
    );
    for (const artifact of artifacts) {
      if (!artifact.bucket || !artifact.objectKey || !artifact.s3VersionId) continue;
      // A version can be shared by another deployment; preserve it until no other active operation references it.
      const other = (
        await repository.listDeploymentsForAgent(input.tenantId, input.agentId, { limit: 100 })
      ).items.some(
        (item) =>
          item.id !== deployment.id &&
          item.status === 'READY' &&
          item.snapshot.artifactId === artifact.id
      );
      if (!other)
        await s3.send(
          new DeleteObjectCommand({
            Bucket: artifact.bucket,
            Key: artifact.objectKey,
            VersionId: artifact.s3VersionId,
            ExpectedBucketOwner: connection.accountId
          })
        );
    }
    return 'READY' as const;
  },
  async verifyAbsent(input: DeploymentCommandInput) {
    const deployment = await repository.getDeployment(input.tenantId, input.deploymentId);
    if (!deployment) return 'FAILED' as const;
    return 'READY' as const;
  }
};
const worker = new DeploymentWorker({
  repository,
  customerRoleAssumer: assumer,
  bedrock: new CatalogBedrockPreflightChecker(),
  dependencies: dependencyProvisioner,
  artifactPipeline: new DeploymentArtifactPipeline({
    repository,
    builder: new AgentArtifactBuilder(
      process.env.AGENT_RUNTIME_SOURCE_PATH ?? '/var/task/runtime-source/app.ts'
    ),
    uploader: new AgentArtifactUploader(assumer),
    now: () => new Date()
  }),
  runtime: new AgentCoreRuntimeDeploymentPort(repository, assumer),
  undeployRuntime: new AgentCoreRuntimeDeploymentPort(repository, assumer),
  undeployDependencies: dependencyProvisioner,
  artifactCleanup
});

export async function handler(event: DeploymentCommandInput & { stage: DeploymentStage }) {
  if (!event?.stage) throw new Error('Deployment stage is required.');
  return worker.dispatch(event.stage, event);
}
