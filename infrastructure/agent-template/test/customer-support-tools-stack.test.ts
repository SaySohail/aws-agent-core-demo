/* eslint-disable @typescript-eslint/no-explicit-any -- synthesized CloudFormation is dynamic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CustomerSupportToolsStack } from '../lib/customer-support-tools-stack.js';

const template = () => {
  const app = new cdk.App();
  return Template.fromStack(new CustomerSupportToolsStack(app, 'TestTools')).toJSON() as any;
};
const resources = (value: any, type: string) =>
  Object.entries(value.Resources).filter(([, resource]: any) => resource.Type === type) as [
    string,
    any
  ][];
const role = (value: any, logicalIdFragment: string) =>
  resources(value, 'AWS::IAM::Role').find(([logicalId]) => logicalId.includes(logicalIdFragment));
const statements = (value: any, logicalId: string) =>
  resources(value, 'AWS::IAM::Policy')
    .filter(([, policy]) => policy.Properties.Roles.some((target: any) => target.Ref === logicalId))
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);

test('Gateway requires AWS IAM inbound authorization and Gateway IAM target credentials', () => {
  const value = template();
  const gateway = resources(value, 'AWS::BedrockAgentCore::Gateway')[0]![1];
  assert.equal(gateway.Properties.AuthorizerType, 'AWS_IAM');
  assert.notEqual(gateway.Properties.AuthorizerType, 'NONE');
  const targets = resources(value, 'AWS::BedrockAgentCore::GatewayTarget');
  assert.equal(targets.length, 3);
  for (const [, target] of targets)
    assert.deepEqual(target.Properties.CredentialProviderConfigurations, [
      { CredentialProviderType: 'GATEWAY_IAM_ROLE' }
    ]);
});

test('Gateway service role trusts AgentCore only for this account and invokes only support Lambdas', () => {
  const value = template();
  const gatewayRole = role(value, 'GatewayServiceRole');
  assert.ok(gatewayRole);
  const trust = gatewayRole[1].Properties.AssumeRolePolicyDocument.Statement[0];
  assert.equal(trust.Principal.Service, 'bedrock-agentcore.amazonaws.com');
  assert.ok(trust.Condition.StringEquals['aws:SourceAccount']);
  assert.ok(trust.Condition.ArnLike['aws:SourceArn']);
  const policies = statements(value, gatewayRole[0]);
  const gatewayStatement = policies.find(
    (statement: any) => statement.Action === 'lambda:InvokeFunction'
  );
  assert.ok(gatewayStatement);
  assert.equal(gatewayStatement.Resource.length, 3);
  assert.ok(!JSON.stringify(policies).includes('dynamodb:'));
  assert.ok(!JSON.stringify(policies).includes('lambda:*'));
  assert.ok(!JSON.stringify(policies).includes('iam:*'));
});

test('tool Lambda roles retain distinct minimal DynamoDB permissions', () => {
  const value = template();
  const all = resources(value, 'AWS::IAM::Policy').flatMap(
    ([, policy]) => policy.Properties.PolicyDocument.Statement
  );
  const dynamo = all.filter((statement: any) =>
    JSON.stringify(statement.Action).includes('dynamodb:')
  );
  assert.ok(
    dynamo.some((statement: any) => JSON.stringify(statement.Action).includes('dynamodb:GetItem'))
  );
  assert.ok(
    dynamo.some((statement: any) => JSON.stringify(statement.Action).includes('dynamodb:Query'))
  );
  assert.ok(
    dynamo.some((statement: any) => JSON.stringify(statement.Action).includes('dynamodb:PutItem'))
  );
  assert.ok(
    !dynamo.some((statement: any) => JSON.stringify(statement.Action).includes('dynamodb:*'))
  );
});
