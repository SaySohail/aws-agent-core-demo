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
        callbackUrls: ['http://localhost:3000/auth/callback'],
        logoutUrls: ['http://localhost:3000/login']
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

    const meLogGroup = new logs.LogGroup(this, 'MeLogGroup', {
      retention: configuration.logRetentionDays,
      removalPolicy: persistentRemovalPolicy
    });
    const meExecutionRole = new iam.Role(this, 'MeExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the authenticated control-plane profile endpoint.'
    });
    meExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [meLogGroup.logGroupArn]
      })
    );
    const meFunction = new NodejsFunction(this, 'MeFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '..', 'lambda', 'me.ts'),
      handler: 'handler',
      environment: { ENVIRONMENT: configuration.name },
      role: meExecutionRole,
      logGroup: meLogGroup,
      bundling: { minify: true, sourceMap: true, target: 'node22' }
    });
    httpApi.addRoutes({
      path: '/me',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('MeIntegration', meFunction, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0
      }),
      authorizer: jwtAuthorizer
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'ControlPlaneTableName', { value: controlPlaneTable.tableName });
    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifactBucket.bucketName });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoWebClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoIssuer', { value: userPool.userPoolProviderUrl });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: userPoolDomain.baseUrl() });
  }
}
