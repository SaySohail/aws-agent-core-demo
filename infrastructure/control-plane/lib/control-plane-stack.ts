import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './environment-config';

export interface ControlPlaneStackProps extends StackProps {
  readonly configuration: EnvironmentConfig;
}

export class ControlPlaneStack extends Stack {
  public constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    const { configuration } = props;
    const persistentRemovalPolicy =
      configuration.removalPolicy === 'retain' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    cdk.Tags.of(this).add('Project', 'agent-launchpad');
    cdk.Tags.of(this).add('Environment', configuration.name);
    cdk.Tags.of(this).add('ManagedBy', 'AWS-CDK');
    cdk.Tags.of(this).add('Plane', 'control-plane');

    const controlPlaneTable = new dynamodb.Table(this, 'ControlPlaneTable', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: configuration.pointInTimeRecovery
      },
      removalPolicy: persistentRemovalPolicy
    });

    // Query membership records by Cognito subject without a table scan:
    // gsi1pk = USER#<cognitoSub>, gsi1sk = TENANT#<tenantId>.
    controlPlaneTable.addGlobalSecondaryIndex({
      indexName: 'MembershipsByUser',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    // Sparse index: only deployed ACTIVE agents are projected, so scheduled metrics collection
    // does not scan tenant partitions.
    controlPlaneTable.addGlobalSecondaryIndex({
      indexName: 'ActiveAgents',
      partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    controlPlaneTable.addGlobalSecondaryIndex({
      indexName: 'RuntimeVersionsByAgent',
      partitionKey: { name: 'gsi4pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi4sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Query a tenant agent's deployment history in chronological order without a table scan:
    // gsi2pk = TENANT#<tenantId>#AGENT#<agentId>, gsi2sk = <createdAt>#<deploymentId>.
    controlPlaneTable.addGlobalSecondaryIndex({
      indexName: 'DeploymentsByAgent',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(configuration.noncurrentVersionRetentionDays)
        }
      ],
      autoDeleteObjects: configuration.removalPolicy === 'destroy',
      removalPolicy: persistentRemovalPolicy
    });

    const healthLogGroup = new logs.LogGroup(this, 'HealthLogGroup', {
      retention: configuration.logRetentionDays,
      removalPolicy: persistentRemovalPolicy
    });

    const healthExecutionRole = new iam.Role(this, 'HealthExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the control-plane health endpoint.'
    });
    healthExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [healthLogGroup.logGroupArn]
      })
    );

    const healthFunction = new NodejsFunction(this, 'HealthFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '..', 'lambda', 'health.ts'),
      handler: 'handler',
      environment: { ENVIRONMENT: configuration.name },
      role: healthExecutionRole,
      logGroup: healthLogGroup,
      bundling: { minify: true, sourceMap: true, target: 'node22' }
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true }
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: persistentRemovalPolicy
    });

    const userPoolClient = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: configuration.webOrigins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: configuration.webOrigins.map((origin) => `${origin}/login`)
      },
      preventUserExistenceErrors: true
    });

    const userPoolDomain = userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `agent-launchpad-${configuration.name}-${configuration.account}`
      }
    });

    const httpApi = new apigwv2.HttpApi(this, 'ControlPlaneHttpApi', {
      description: 'Control-plane HTTP API.'
    });
    const jwtAuthorizer = new HttpJwtAuthorizer(
      'CognitoJwtAuthorizer',
      userPool.userPoolProviderUrl,
      {
        jwtAudience: [userPoolClient.userPoolClientId]
      }
    );
    httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', healthFunction, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0
      })
    });

    const controlApiLogGroup = new logs.LogGroup(this, 'ControlApiLogGroup', {
      retention: configuration.logRetentionDays,
      removalPolicy: persistentRemovalPolicy
    });
    const controlApiExecutionRole = new iam.Role(this, 'ControlApiExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for authenticated control-plane API routes.'
    });
    controlApiExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [controlApiLogGroup.logGroupArn]
      })
    );
    const deploymentWorkerLogGroup = new logs.LogGroup(this, 'DeploymentWorkerLogGroup', {
      retention: configuration.logRetentionDays,
      removalPolicy: persistentRemovalPolicy
    });
    const deploymentWorkerRole = new iam.Role(this, 'DeploymentWorkerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Deployment orchestration worker; assumes only the customer bootstrap deployment role.'
    });
    deploymentWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [deploymentWorkerLogGroup.logGroupArn]
      })
    );
    deploymentWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query'
        ],
        resources: [controlPlaneTable.tableArn, `${controlPlaneTable.tableArn}/index/*`]
      })
    );
    deploymentWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/AgentLaunchpadDeploymentRole']
      })
    );
    const deploymentWorkerFunction = new NodejsFunction(this, 'DeploymentWorkerFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(
        __dirname,
        '..',
        '..',
        '..',
        'services',
        'deployment-worker',
        'src',
        'lambda.ts'
      ),
      handler: 'handler',
      role: deploymentWorkerRole,
      logGroup: deploymentWorkerLogGroup,
      timeout: Duration.minutes(1),
      environment: {
        CONTROL_PLANE_TABLE_NAME: controlPlaneTable.tableName,
        AGENT_RUNTIME_SOURCE_PATH: '/var/task/runtime-source/app.ts',
        AGENT_DEPENDENCY_TEMPLATE_URL: configuration.agentDependencyTemplateUrl
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        commandHooks: {
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [
              `node -e "require('node:fs').cpSync(process.argv[1], process.argv[2], { recursive: true })" "${inputDir}/agents/customer-support/src" "${outputDir}/runtime-source"`
            ];
          },
          beforeBundling(): string[] {
            return [];
          },
          beforeInstall(): string[] {
            return [];
          }
        }
      }
    });
    const metricsWorkerLogGroup = new logs.LogGroup(this, 'MetricsWorkerLogGroup', {
      retention: configuration.logRetentionDays,
      removalPolicy: persistentRemovalPolicy
    });
    const metricsWorkerRole = new iam.Role(this, 'MetricsWorkerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Scheduled, read-only customer CloudWatch metrics collector.'
    });
    metricsWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [metricsWorkerLogGroup.logGroupArn]
      })
    );
    metricsWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [controlPlaneTable.tableArn, `${controlPlaneTable.tableArn}/index/*`]
      })
    );
    metricsWorkerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/AgentLaunchpadDeploymentRole']
      })
    );
    const metricsWorkerFunction = new NodejsFunction(this, 'MetricsWorkerFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(
        __dirname,
        '..',
        '..',
        '..',
        'services',
        'metrics-worker',
        'src',
        'lambda.ts'
      ),
      handler: 'handler',
      role: metricsWorkerRole,
      logGroup: metricsWorkerLogGroup,
      timeout: Duration.minutes(2),
      environment: { CONTROL_PLANE_TABLE_NAME: controlPlaneTable.tableName },
      bundling: { minify: true, sourceMap: true, target: 'node22' }
    });
    new events.Rule(this, 'MetricsCollectionSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(metricsWorkerFunction)]
    });
    const stateMachineLogGroup = new logs.LogGroup(this, 'DeploymentStateMachineLogGroup', {
      retention: configuration.logRetentionDays,
      removalPolicy: persistentRemovalPolicy
    });
    const failed = new sfn.Fail(this, 'DeploymentFailed', { error: 'Deployment.Failed' });
    const invoke = (stage: string, catchTarget: sfn.IChainable = failed) =>
      new sfnTasks.LambdaInvoke(this, `${stage}Task`, {
        lambdaFunction: deploymentWorkerFunction,
        payload: sfn.TaskInput.fromObject({
          stage,
          'deploymentId.$': '$.deploymentId',
          'tenantId.$': '$.tenantId',
          'agentId.$': '$.agentId',
          'configurationRevision.$': '$.configurationRevision',
          'artifactId.$': '$.artifactId',
          'operationType.$': '$.operationType'
        }),
        resultPath: '$.task',
        timeout: Duration.minutes(2),
        retryOnServiceExceptions: false
      })
        .addRetry({
          // DeploymentError.name is deliberately canonicalized by the worker boundary.
          errors: ['Deployment.Transient'],
          interval: Duration.seconds(2),
          backoffRate: 2,
          maxAttempts: 4,
          maxDelay: Duration.seconds(30),
          jitterStrategy: sfn.JitterType.FULL
        })
        .addCatch(catchTarget, { resultPath: '$.failure' });
    const stages = [
      'VALIDATING',
      'VERIFYING_CUSTOMER_ACCESS',
      'PREFLIGHT_REGION',
      'PREFLIGHT_MODEL',
      'PREFLIGHT_IAM',
      'PREFLIGHT_STORAGE',
      'PREFLIGHT_AGENTCORE',
      'ENSURING_ARTIFACT',
      'PROVISIONING_DEPENDENCIES',
      'WAITING_FOR_DEPENDENCIES',
      'DEPLOYING_RUNTIME',
      'WAITING_FOR_RUNTIME',
      'HEALTH_CHECKING',
      'PROMOTING_ENDPOINT',
      'WAITING_FOR_ENDPOINT'
    ];
    const tasks = stages.map((stage) => invoke(stage));
    const dependencyWait = new sfn.Wait(this, 'DependencyWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const runtimeWait = new sfn.Wait(this, 'RuntimeWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const endpointWait = new sfn.Wait(this, 'EndpointWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const ready = new sfn.Succeed(this, 'DeploymentReady');
    const dependencyChoice = new sfn.Choice(this, 'DependenciesReady?')
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'READY'), tasks[9]!)
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'FAILED'), failed)
      .otherwise(dependencyWait);
    const runtimeChoice = new sfn.Choice(this, 'RuntimeReady?')
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'READY'), tasks[11]!)
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'FAILED'), failed)
      .otherwise(runtimeWait);
    const endpointChoice = new sfn.Choice(this, 'ProductionEndpointReady?')
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'READY'), ready)
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'FAILED'), failed)
      .otherwise(endpointWait);
    dependencyWait.next(tasks[9]!);
    runtimeWait.next(tasks[11]!);
    endpointWait.next(tasks[14]!);
    tasks[0]!
      .next(tasks[1]!)
      .next(tasks[2]!)
      .next(tasks[3]!)
      .next(tasks[4]!)
      .next(tasks[5]!)
      .next(tasks[6]!)
      .next(tasks[7]!)
      .next(tasks[8]!)
      .next(dependencyChoice);
    tasks[9]!.next(tasks[10]!).next(runtimeChoice);
    tasks[11]!.next(tasks[12]!).next(tasks[13]!).next(tasks[14]!).next(endpointChoice);
    const rollbackCompensation = invoke('ROLLBACK_REVERTING_ENDPOINT');
    const rollbackStages = [
      'ROLLBACK_VALIDATING',
      'ROLLBACK_VERIFYING_TARGET',
      'ROLLBACK_UPDATING_ENDPOINT',
      'ROLLBACK_WAITING_FOR_ENDPOINT',
      'ROLLBACK_HEALTH_CHECKING'
    ].map((stage) =>
      stage === 'ROLLBACK_HEALTH_CHECKING' ? invoke(stage, rollbackCompensation) : invoke(stage)
    );
    const rollbackWait = new sfn.Wait(this, 'RollbackEndpointWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const rollbackReady = new sfn.Succeed(this, 'RollbackReady');
    const rollbackEndpointReady = new sfn.Choice(this, 'RollbackEndpointReady?')
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'READY'), rollbackStages[4]!)
      .when(sfn.Condition.stringEquals('$.task.Payload.status', 'FAILED'), rollbackCompensation)
      .otherwise(rollbackWait);
    rollbackWait.next(rollbackStages[3]!);
    rollbackStages[0]!
      .next(rollbackStages[1]!)
      .next(rollbackStages[2]!)
      .next(rollbackStages[3]!)
      .next(rollbackEndpointReady);
    rollbackStages[4]!.next(rollbackReady);
    rollbackCompensation.next(failed);
    const undeployStages = [
      'UNDEPLOY_VALIDATING',
      'UNDEPLOY_DISABLING_INVOCATION',
      'UNDEPLOY_DELETING_ENDPOINT',
      'UNDEPLOY_WAITING_ENDPOINT',
      'UNDEPLOY_DELETING_RUNTIME',
      'UNDEPLOY_WAITING_RUNTIME',
      'UNDEPLOY_DELETING_DEPENDENCIES',
      'UNDEPLOY_WAITING_DEPENDENCIES',
      'UNDEPLOY_DELETING_ARTIFACTS',
      'UNDEPLOY_VERIFYING'
    ].map((stage) => invoke(stage));
    const undeployEndpointWait = new sfn.Wait(this, 'UndeployEndpointWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const undeployRuntimeWait = new sfn.Wait(this, 'UndeployRuntimeWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const undeployDependenciesWait = new sfn.Wait(this, 'UndeployDependenciesWait', {
      time: sfn.WaitTime.duration(Duration.seconds(20))
    });
    const undeployReady = new sfn.Succeed(this, 'UndeployReady');
    const poll = (id: string, task: sfn.State, wait: sfn.Wait) =>
      new sfn.Choice(this, id)
        .when(sfn.Condition.stringEquals('$.task.Payload.status', 'READY'), task)
        .when(sfn.Condition.stringEquals('$.task.Payload.status', 'FAILED'), failed)
        .otherwise(wait);
    const endpointDeleted = poll('EndpointDeleted?', undeployStages[4]!, undeployEndpointWait);
    const runtimeDeleted = poll('RuntimeDeleted?', undeployStages[6]!, undeployRuntimeWait);
    const dependenciesDeleted = poll(
      'DependenciesDeleted?',
      undeployStages[8]!,
      undeployDependenciesWait
    );
    undeployEndpointWait.next(undeployStages[3]!);
    undeployRuntimeWait.next(undeployStages[5]!);
    undeployDependenciesWait.next(undeployStages[7]!);
    undeployStages[0]!
      .next(undeployStages[1]!)
      .next(undeployStages[2]!)
      .next(undeployStages[3]!)
      .next(endpointDeleted);
    undeployStages[4]!.next(undeployStages[5]!).next(runtimeDeleted);
    undeployStages[6]!.next(undeployStages[7]!).next(dependenciesDeleted);
    undeployStages[8]!.next(undeployStages[9]!).next(undeployReady);
    const invalidOperation = new sfn.Fail(this, 'InvalidLifecycleOperation', {
      error: 'Deployment.InvalidOperation'
    });
    const operationChoice = new sfn.Choice(this, 'LifecycleOperation')
      .when(sfn.Condition.stringEquals('$.operationType', 'DEPLOY'), tasks[0]!)
      .when(sfn.Condition.stringEquals('$.operationType', 'ROLLBACK'), rollbackStages[0]!)
      .when(sfn.Condition.stringEquals('$.operationType', 'UNDEPLOY'), undeployStages[0]!)
      .otherwise(invalidOperation);
    const deploymentStateMachine = new sfn.StateMachine(this, 'DeploymentStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(operationChoice),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.hours(2),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: false
      }
    });
    deploymentStateMachine.grantStartExecution(controlApiExecutionRole);
    // Customer bootstrap v1 creates exactly this cross-account role; customer trust still enforces ExternalId.
    controlApiExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/AgentLaunchpadDeploymentRole']
      })
    );
    controlApiExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query'
        ],
        resources: [controlPlaneTable.tableArn, `${controlPlaneTable.tableArn}/index/*`]
      })
    );
    const controlApiFunction = new NodejsFunction(this, 'ControlApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '..', '..', '..', 'services', 'control-api', 'src', 'lambda.ts'),
      handler: 'handler',
      environment: {
        ENVIRONMENT: configuration.name,
        CONTROL_PLANE_TABLE_NAME: controlPlaneTable.tableName,
        CUSTOMER_BOOTSTRAP_TEMPLATE_URL: configuration.customerBootstrapTemplateUrl,
        CONTROL_API_EXECUTION_ROLE_ARN: controlApiExecutionRole.roleArn,
        CUSTOMER_CONNECTION_ALLOWED_REGIONS: configuration.region,
        DEPLOYMENT_STATE_MACHINE_ARN: deploymentStateMachine.stateMachineArn
      },
      role: controlApiExecutionRole,
      logGroup: controlApiLogGroup,
      bundling: { minify: true, sourceMap: true, target: 'node22' }
    });
    const controlIntegration = new HttpLambdaIntegration(
      'ControlApiIntegration',
      controlApiFunction,
      { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0 }
    );
    const authenticatedRoutes: Array<{ path: string; methods: apigwv2.HttpMethod[] }> = [
      { path: '/me', methods: [apigwv2.HttpMethod.GET] },
      { path: '/tenants', methods: [apigwv2.HttpMethod.GET] },
      { path: '/tenants/{tenantId}', methods: [apigwv2.HttpMethod.GET] },
      { path: '/agent-templates', methods: [apigwv2.HttpMethod.GET] },
      {
        path: '/agent-templates/{templateId}/versions/{version}',
        methods: [apigwv2.HttpMethod.GET]
      },
      {
        path: '/tenants/{tenantId}/agents',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST]
      },
      {
        path: '/tenants/{tenantId}/agents/{agentId}',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH]
      },
      {
        path: '/tenants/{tenantId}/agents/{agentId}/deployments',
        methods: [apigwv2.HttpMethod.GET]
      },
      { path: '/tenants/{tenantId}/agents/{agentId}/versions', methods: [apigwv2.HttpMethod.GET] },
      { path: '/tenants/{tenantId}/agents/{agentId}/rollback', methods: [apigwv2.HttpMethod.POST] },
      { path: '/tenants/{tenantId}/agents/{agentId}/undeploy', methods: [apigwv2.HttpMethod.POST] },
      { path: '/tenants/{tenantId}/agents/{agentId}/deploy', methods: [apigwv2.HttpMethod.POST] },
      { path: '/tenants/{tenantId}/agents/{agentId}/invoke', methods: [apigwv2.HttpMethod.POST] },
      {
        path: '/tenants/{tenantId}/agents/{agentId}/executions',
        methods: [apigwv2.HttpMethod.GET]
      },
      { path: '/tenants/{tenantId}/agents/{agentId}/metrics', methods: [apigwv2.HttpMethod.GET] },
      { path: '/tenants/{tenantId}/audit-events', methods: [apigwv2.HttpMethod.GET] },
      {
        path: '/tenants/{tenantId}/aws-connections',
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST]
      },
      {
        path: '/tenants/{tenantId}/aws-connections/{connectionId}',
        methods: [apigwv2.HttpMethod.GET]
      },
      {
        path: '/tenants/{tenantId}/aws-connections/{connectionId}/verify',
        methods: [apigwv2.HttpMethod.POST]
      },
      { path: '/tenants/{tenantId}/deployments', methods: [apigwv2.HttpMethod.GET] },
      {
        path: '/tenants/{tenantId}/deployments/{deploymentId}',
        methods: [apigwv2.HttpMethod.GET]
      },
      {
        path: '/tenants/{tenantId}/deployments/{deploymentId}/retry',
        methods: [apigwv2.HttpMethod.POST]
      }
    ];
    for (const route of authenticatedRoutes)
      httpApi.addRoutes({ ...route, integration: controlIntegration, authorizer: jwtAuthorizer });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'ControlPlaneTableName', { value: controlPlaneTable.tableName });
    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifactBucket.bucketName });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoWebClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoIssuer', { value: userPool.userPoolProviderUrl });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: userPoolDomain.baseUrl() });
  }
}
