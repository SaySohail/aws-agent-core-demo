import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class CustomerBootstrapStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const trustedControlPlanePrincipalArn = new cdk.CfnParameter(
      this,
      'TrustedControlPlanePrincipalArn',
      {
        type: 'String',
        minLength: 20,
        description:
          'Exact Agent Launchpad control-plane IAM principal ARN allowed to assume the deployment role.'
      }
    );
    const externalId = new cdk.CfnParameter(this, 'ExternalId', {
      type: 'String',
      minLength: 1,
      noEcho: true,
      description:
        'Unique Agent Launchpad AWS connection identifier used for STS confused-deputy protection.'
    });
    cdk.Tags.of(this).add('ManagedBy', 'AgentLaunchpad');
    cdk.Tags.of(this).add('Plane', 'DataPlane');
    cdk.Tags.of(this).add('Purpose', 'CustomerBootstrap');

    const artifactKey = new kms.Key(this, 'ArtifactKey', {
      alias: 'alias/agent-launchpad-artifacts',
      description: 'Encrypts Agent Launchpad deployment artifacts in this customer account.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: artifactKey,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(90)
        }
      ],
      removalPolicy: RemovalPolicy.RETAIN
    });

    const runtimeExecutionRole = new iam.Role(this, 'RuntimeExecutionRole', {
      roleName: 'AgentLaunchpadRuntimeExecutionRole',
      description: 'Execution role assumed only by Amazon Bedrock AgentCore runtime workloads.',
      assumedBy: new iam.PrincipalWithConditions(
        new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({
              service: 'bedrock-agentcore',
              resource: '*'
            })
          }
        }
      )
    });

    const runtimeLogGroupArn = `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*`;
    const foundationModelArn = `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}::foundation-model/*`;
    runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [runtimeLogGroupArn]
      })
    );
    runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${runtimeLogGroupArn}:log-stream:*`]
      })
    );
    runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`
        ]
      })
    );
    runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets'
        ],
        resources: ['*']
      })
    );
    runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } }
      })
    );
    runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [foundationModelArn]
      })
    );

    const deploymentRole = new iam.Role(this, 'DeploymentRole', {
      roleName: 'AgentLaunchpadDeploymentRole',
      description:
        'Cross-account role used by Agent Launchpad to manage only its customer-account resources.',
      assumedBy: new iam.ArnPrincipal(trustedControlPlanePrincipalArn.valueAsString).withConditions(
        {
          StringEquals: { 'sts:ExternalId': externalId.valueAsString }
        }
      )
    });

    deploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetBucketLocation', 's3:ListBucket'],
        resources: [artifactBucket.bucketArn]
      })
    );
    deploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
        resources: [artifactBucket.arnForObjects('*')]
      })
    );
    artifactKey.grantEncryptDecrypt(deploymentRole);
    deploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [runtimeExecutionRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' } }
      })
    );
    // Create/List cannot be scoped to a runtime ARN by AgentCore IAM; request tags bind creation to this product.
    deploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:CreateAgentRuntime', 'bedrock-agentcore:ListAgentRuntimes'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': cdk.Aws.REGION },
          'ForAllValues:StringEquals': { 'aws:TagKeys': ['ManagedBy', 'Plane', 'Purpose'] },
          'ForAllValues:StringEqualsIfExists': {
            'aws:RequestTag/ManagedBy': 'AgentLaunchpad',
            'aws:RequestTag/Plane': 'DataPlane',
            'aws:RequestTag/Purpose': 'CustomerBootstrap'
          }
        }
      })
    );
    deploymentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:DeleteAgentRuntime',
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:UpdateAgentRuntime'
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'bedrock-agentcore',
            resource: 'runtime',
            resourceName: '*'
          })
        ],
        conditions: { StringEquals: { 'aws:ResourceTag/ManagedBy': 'AgentLaunchpad' } }
      })
    );

    new cdk.CfnOutput(this, 'DeploymentRoleArn', { value: deploymentRole.roleArn });
    new cdk.CfnOutput(this, 'RuntimeExecutionRoleArn', { value: runtimeExecutionRole.roleArn });
    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifactBucket.bucketName });
    new cdk.CfnOutput(this, 'ArtifactBucketArn', { value: artifactBucket.bucketArn });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: artifactKey.keyArn });
    new cdk.CfnOutput(this, 'BootstrapVersion', { value: '1' });
  }
}
