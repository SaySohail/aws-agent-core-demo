/* eslint-disable @typescript-eslint/no-explicit-any -- CloudFormation JSON is intentionally dynamic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CustomerBootstrapStack } from '../lib/customer-bootstrap-stack.js';

const synthesized = (): Record<string, unknown> => {
  const app = new cdk.App();
  const stack = new CustomerBootstrapStack(app, 'TestBootstrap');
  return Template.fromStack(stack).toJSON();
};

const resourcesOfType = (
  template: Record<string, unknown>,
  type: string
): Record<string, Record<string, any>> =>
  Object.fromEntries(
    Object.entries(template.Resources as Record<string, Record<string, any>>).filter(
      ([, resource]) => resource.Type === type
    )
  );

const roleByName = (template: Record<string, unknown>, roleName: string): Record<string, any> => {
  const entry = Object.entries(resourcesOfType(template, 'AWS::IAM::Role')).find(
    ([, role]) => role.Properties.RoleName === roleName
  );
  assert.ok(entry, `role ${roleName} must exist`);
  return { logicalId: entry[0], ...entry[1] };
};

const policyStatementsForRole = (
  template: Record<string, unknown>,
  role: Record<string, any>
): Record<string, any>[] =>
  Object.values(resourcesOfType(template, 'AWS::IAM::Policy'))
    .filter((policy) =>
      policy.Properties.Roles.some(
        (target: Record<string, string>) => target.Ref === role.logicalId
      )
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);

test('requires the exact deployment principal and external ID trust contract', () => {
  const template = synthesized();
  const parameters = template.Parameters as Record<string, Record<string, unknown>>;
  const trustedParameter = parameters.TrustedControlPlanePrincipalArn;
  const externalIdParameter = parameters.ExternalId;
  assert.ok(trustedParameter);
  assert.ok(externalIdParameter);
  assert.equal(trustedParameter.Default, undefined);
  assert.equal(externalIdParameter.Default, undefined);
  assert.equal(externalIdParameter.MinLength, 1);

  const deploymentRole = roleByName(template, 'AgentLaunchpadDeploymentRole');
  const statement = deploymentRole.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(statement.Principal.AWS, { Ref: 'TrustedControlPlanePrincipalArn' });
  assert.deepEqual(statement.Condition.StringEquals['sts:ExternalId'], { Ref: 'ExternalId' });
});

test('separates roles and avoids broad managed policies or arbitrary PassRole', () => {
  const template = synthesized();
  const deploymentRole = roleByName(template, 'AgentLaunchpadDeploymentRole');
  const runtimeRole = roleByName(template, 'AgentLaunchpadRuntimeExecutionRole');
  assert.notEqual(deploymentRole, runtimeRole);
  assert.equal(deploymentRole.Properties.ManagedPolicyArns, undefined);
  assert.equal(runtimeRole.Properties.ManagedPolicyArns, undefined);

  const passRole = policyStatementsForRole(template, deploymentRole).find(
    (statement) => statement.Action === 'iam:PassRole'
  );
  assert.ok(passRole);
  assert.notEqual(passRole.Resource, '*');
  assert.deepEqual(
    passRole.Condition.StringEquals['iam:PassedToService'],
    'bedrock-agentcore.amazonaws.com'
  );
});

test('runtime role trusts AgentCore and has no broad Bedrock or Gateway wildcard permission', () => {
  const template = synthesized();
  const runtimeRole = roleByName(template, 'AgentLaunchpadRuntimeExecutionRole');
  const trust = runtimeRole.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.equal(trust.Principal.Service, 'bedrock-agentcore.amazonaws.com');
  assert.ok(trust.Condition.StringEquals['aws:SourceAccount']);

  const statements = policyStatementsForRole(template, runtimeRole);
  const actions = statements.flatMap((statement: Record<string, any>) => statement.Action);
  assert.ok(actions.includes('bedrock:InvokeModel'));
  assert.ok(actions.includes('bedrock:InvokeModelWithResponseStream'));
  assert.ok(!actions.includes('bedrock:*'));
  assert.ok(!actions.includes('bedrock-agentcore:InvokeGateway'));
  assert.ok(!actions.some((action: string) => action === 'bedrock-agentcore:*'));
  assert.ok(
    !actions.some(
      (action: string) =>
        action.startsWith('bedrock-agentcore:') && action !== 'bedrock-agentcore:InvokeGateway'
    )
  );
});

test('deployment role has no wildcard runtime invocation grant; Runtime policies grant exact ARNs', () => {
  const template = synthesized();
  const deploymentRole = roleByName(template, 'AgentLaunchpadDeploymentRole');
  const actions = policyStatementsForRole(template, deploymentRole).flatMap(
    (statement: Record<string, any>) => statement.Action
  );
  assert.ok(!actions.includes('bedrock-agentcore:InvokeAgentRuntime'));
  assert.ok(!actions.includes('bedrock-agentcore:InvokeAgentRuntimeForUser'));
  assert.ok(!actions.includes('bedrock-agentcore:*'));
});

test('deployment role has narrow Gateway and Policy lifecycle permissions', () => {
  const template = synthesized();
  const deploymentRole = roleByName(template, 'AgentLaunchpadDeploymentRole');
  const statements = policyStatementsForRole(template, deploymentRole);
  const actions = statements.flatMap((statement: Record<string, any>) => statement.Action);
  for (const action of [
    'bedrock-agentcore:CreatePolicyEngine',
    'bedrock-agentcore:UpdatePolicyEngine',
    'bedrock-agentcore:DeletePolicyEngine',
    'bedrock-agentcore:CreatePolicy',
    'bedrock-agentcore:UpdatePolicy',
    'bedrock-agentcore:DeletePolicy',
    'bedrock-agentcore:InvokeGateway',
    'bedrock-agentcore:ManageResourceScopedPolicy'
  ])
    assert.ok(actions.includes(action));
  assert.ok(!actions.includes('bedrock-agentcore:ManageAdminPolicy'));
  assert.ok(!actions.includes('bedrock-agentcore:*'));
});

test('artifact storage is private, KMS encrypted, TLS-only, and role-scoped', () => {
  const template = synthesized();
  const bucket = Object.values(resourcesOfType(template, 'AWS::S3::Bucket'))[0];
  assert.ok(bucket);
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true
  });
  assert.equal(
    bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
      .ServerSideEncryptionByDefault.SSEAlgorithm,
    'aws:kms'
  );
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');

  const bucketPolicy = Object.values(resourcesOfType(template, 'AWS::S3::BucketPolicy'))[0];
  assert.ok(bucketPolicy);
  const denyInsecure = bucketPolicy.Properties.PolicyDocument.Statement.find(
    (statement: Record<string, any>) =>
      statement.Condition?.Bool?.['aws:SecureTransport'] === 'false'
  );
  assert.ok(denyInsecure);

  const deploymentRole = roleByName(template, 'AgentLaunchpadDeploymentRole');
  const s3Statements = policyStatementsForRole(template, deploymentRole).filter((statement) =>
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).some(
      (action: string) => action.startsWith('s3:')
    )
  );
  assert.ok(s3Statements.length > 0);
  assert.ok(s3Statements.every((statement: Record<string, any>) => statement.Resource !== '*'));
});

test('does not create credentials, users, AgentCore runtimes, or gateways', () => {
  const template = synthesized();
  const types = Object.values(template.Resources as Record<string, Record<string, any>>).map(
    (resource) => resource.Type
  );
  assert.ok(!types.includes('AWS::IAM::User'));
  assert.ok(!types.includes('AWS::IAM::AccessKey'));
  assert.ok(!types.some((type) => type.includes('BedrockAgentCore::Runtime')));
  assert.ok(!types.some((type) => type.includes('BedrockAgentCore::Gateway')));
});
