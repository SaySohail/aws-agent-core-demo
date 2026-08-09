import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand
} from '@aws-sdk/client-bedrock-agentcore-control';
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
import { AgentCoreControlPlanePreflightChecker } from './agentcore-preflight.js';

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
      if (other) {
        const now = new Date().toISOString();
        await repository.updateDeploymentCleanupLedger(
          input.tenantId,
          input.deploymentId,
          (deployment.cleanupLedger ?? []).map((entry) =>
            entry.kind === 'ARTIFACT' && entry.logicalId === artifact.id
              ? { ...entry, status: 'SKIPPED' as const, updatedAt: now }
              : entry
          )
        );
      } else
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
    const connection =
      deployment &&
      (await repository.getAwsConnection(input.tenantId, deployment.snapshot.awsConnectionId));
    const plan = deployment?.cleanupPlan;
    if (
      !deployment ||
      deployment.operationType !== 'UNDEPLOY' ||
      !plan?.runtimeId ||
      !connection ||
      connection.status !== 'VERIFIED' ||
      connection.accountId !== plan.accountId ||
      connection.region !== plan.region
    )
      return 'FAILED' as const;
    const credentials = await assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `verify-cleanup-${deployment.id}`
    });
    const runtime = new BedrockAgentCoreControlClient({ region: plan.region, credentials });
    const cloudFormation = new CloudFormationClient({ region: plan.region, credentials });
    const s3 = new S3Client({ region: plan.region, credentials });
    const absent = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return false;
      } catch (cause) {
        return (
          cause instanceof Error &&
          /NotFound|does not exist|not exist/i.test(cause.name + cause.message)
        );
      }
    };
    if (
      !(await absent(() =>
        runtime.send(
          new GetAgentRuntimeEndpointCommand({
            agentRuntimeId: plan.runtimeId!,
            endpointName: 'production'
          })
        )
      )) ||
      !(await absent(() =>
        runtime.send(new GetAgentRuntimeCommand({ agentRuntimeId: plan.runtimeId! }))
      ))
    )
      return 'PENDING' as const;
    if (
      plan.dependencyStackName &&
      !(await absent(() =>
        cloudFormation.send(new DescribeStacksCommand({ StackName: plan.dependencyStackName! }))
      ))
    )
      return 'PENDING' as const;
    for (const artifactId of plan.artifactIds) {
      const artifact = await repository.getAgentArtifact(input.tenantId, artifactId);
      const ledger = deployment.cleanupLedger?.find(
        (entry) => entry.kind === 'ARTIFACT' && entry.logicalId === artifactId
      );
      if (
        !artifact ||
        artifact.agentId !== input.agentId ||
        !artifact.bucket ||
        !artifact.objectKey ||
        !artifact.s3VersionId
      )
        return 'FAILED' as const;
      if (ledger?.status === 'SKIPPED') {
        const retained = (
          await repository.listDeploymentsForAgent(input.tenantId, input.agentId, { limit: 100 })
        ).items.some(
          (other) =>
            other.id !== deployment.id &&
            other.status === 'READY' &&
            other.snapshot.artifactId === artifact.id
        );
        if (retained) continue;
        return 'FAILED' as const;
      }
      if (
        !(await absent(() =>
          s3.send(
            new HeadObjectCommand({
              Bucket: artifact.bucket!,
              Key: artifact.objectKey!,
              VersionId: artifact.s3VersionId!,
              ExpectedBucketOwner: connection.accountId
            })
          )
        ))
      )
        return 'PENDING' as const;
    }
    return 'READY' as const;
  }
};
const worker = new DeploymentWorker({
  repository,
  customerRoleAssumer: assumer,
  bedrock: new CatalogBedrockPreflightChecker(),
  agentCore: new AgentCoreControlPlanePreflightChecker(
    repository,
    assumer,
    (input) => new BedrockAgentCoreControlClient(input)
  ),
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
  if (
    !event?.stage ||
    !['DEPLOY', 'ROLLBACK', 'UNDEPLOY'].includes(event.operationType) ||
    !event.deploymentId ||
    !event.tenantId ||
    !event.agentId
  )
    throw new Error('A complete, valid lifecycle task payload is required.');
  return worker.dispatch(event.stage, event);
}
