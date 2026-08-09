/* eslint-disable @typescript-eslint/no-explicit-any -- synthesized CloudFormation is dynamic. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CustomerSupportToolsStack } from '../lib/customer-support-tools-stack.js';

const template = (
  agentId?: string,
  agentResourceIdentifier?: string,
  agentResourceHash?: string
) => {
  const app = new cdk.App();
  return Template.fromStack(
    new CustomerSupportToolsStack(app, 'TestTools', {
      ...(agentId ? { agentId } : {}),
      ...(agentResourceIdentifier ? { agentResourceIdentifier } : {}),
      ...(agentResourceHash ? { agentResourceHash } : {})
    })
  ).toJSON() as any;
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
  assert.equal(targets.length, 4);
  for (const [, target] of targets)
    assert.deepEqual(target.Properties.CredentialProviderConfigurations, [
      { CredentialProviderType: 'GATEWAY_IAM_ROLE' }
    ]);
});

test('two Agent stacks use deterministic, distinct physical names and ownership tags', () => {
  const first = template('agt_alpha-001', 'agt-alpha-001-aaaaaaaaaaaa', 'aaaaaaaaaaaa');
  const repeat = template('agt_alpha-001', 'agt-alpha-001-aaaaaaaaaaaa', 'aaaaaaaaaaaa');
  const second = template('agt_beta-001', 'agt-beta-001-bbbbbbbbbbbb', 'bbbbbbbbbbbb');
  const names = (value: any) => ({
    gateway: resources(value, 'AWS::BedrockAgentCore::Gateway')[0]![1].Properties.Name,
    table: resources(value, 'AWS::DynamoDB::Table')[0]![1].Properties.TableName,
    policyEngine: resources(value, 'AWS::BedrockAgentCore::PolicyEngine')[0]![1].Properties.Name,
    roles: resources(value, 'AWS::IAM::Role').map(([, resource]) => resource.Properties.RoleName),
    functions: resources(value, 'AWS::Lambda::Function').map(
      ([, resource]) => resource.Properties.FunctionName
    )
  });
  assert.deepEqual(names(first), names(repeat));
  assert.notDeepEqual(names(first), names(second));
  assert.match(names(first).gateway, /agt-alpha-001-aaaaaaaaaaaa$/);
  assert.ok(
    names(first)
      .roles.filter(Boolean)
      .every((name: string) => name.includes('agt-alpha-001-aaaaaaaaaaaa'))
  );
  assert.ok(
    names(first)
      .functions.filter(Boolean)
      .every((name: string) => name.includes('agt-alpha-001-aaaaaaaaaaaa'))
  );
  const gateway = resources(first, 'AWS::BedrockAgentCore::Gateway')[0]![1];
  assert.equal(gateway.Properties.Tags.AgentId, 'agt_alpha-001');
  assert.equal(gateway.Properties.Tags.ManagedBy, 'AgentLaunchpad');
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
  assert.equal(gatewayStatement.Resource.length, 4);
  assert.ok(!JSON.stringify(policies).includes('dynamodb:'));
  assert.ok(!JSON.stringify(policies).includes('lambda:*'));
  assert.ok(!JSON.stringify(policies).includes('iam:*'));
});

test('the shared Runtime Execution Role receives an exact Gateway resource-policy grant', () => {
  const value = template();
  const policy = resources(value, 'AWS::BedrockAgentCore::ResourcePolicy')[0]![1];
  assert.equal(policy.Properties.ResourceArn['Fn::GetAtt'][1], 'GatewayArn');
  const rendered = JSON.stringify(policy.Properties.Policy);
  assert.ok(rendered.includes('AgentLaunchpadRuntimeExecutionRole'));
  assert.ok(rendered.includes('bedrock-agentcore:InvokeGateway'));
  assert.ok(!rendered.includes('gateway/*'));
});

test('enforces validated exact-action Cedar policies through the support Gateway', () => {
  const value = template();
  const gateway = resources(value, 'AWS::BedrockAgentCore::Gateway')[0]![1];
  assert.equal(gateway.Properties.PolicyEngineConfiguration.Mode, 'ENFORCE');
  assert.ok(gateway.Properties.PolicyEngineConfiguration.Arn);
  assert.equal(resources(value, 'AWS::BedrockAgentCore::PolicyEngine').length, 1);
  const policies = resources(value, 'AWS::BedrockAgentCore::Policy');
  assert.equal(policies.length, 5);
  const rendered = JSON.stringify(policies.map(([, policy]) => policy.Properties));
  assert.ok(rendered.includes('FAIL_ON_ANY_FINDINGS'));
  assert.ok(!rendered.includes('IGNORE_ALL_FINDINGS'));
  assert.ok(rendered.includes('ACTIVE'));
  for (const action of [
    'GetOrderTarget-',
    'SearchOrdersTarget-',
    'CreateTicketTarget-',
    'ProcessRefundTarget-'
  ])
    assert.ok(rendered.includes(action));
  assert.ok(rendered.includes('context.input.amountCents <= 10000'));
  assert.ok(rendered.includes('context.input.amountCents > 10000'));
  assert.ok(rendered.includes('AgentCore::IamEntity'));
  assert.ok(rendered.includes('GatewayArn'));
  assert.ok(!rendered.includes('Action::*'));
});

test('Gateway role has only exact policy-evaluation permissions and no AgentCore wildcard', () => {
  const value = template();
  const gatewayRole = role(value, 'GatewayServiceRole');
  assert.ok(gatewayRole);
  const policies = statements(value, gatewayRole[0]);
  const serialized = JSON.stringify(policies);
  for (const action of [
    'bedrock-agentcore:AuthorizeAction',
    'bedrock-agentcore:PartiallyAuthorizeActions',
    'bedrock-agentcore:GetPolicyEngine'
  ])
    assert.ok(serialized.includes(action));
  assert.ok(!serialized.includes('bedrock-agentcore:*'));
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

test('Gateway workload identity is surfaced only as trusted identity metadata', () => {
  const value = template();
  const output = value.Outputs.GatewayWorkloadIdentityArn;
  assert.deepEqual(output.Value['Fn::GetAtt'], [
    'CustomerSupportGateway',
    'WorkloadIdentityDetails.WorkloadIdentityArn'
  ]);
  assert.ok(!JSON.stringify(value.Outputs).includes('Credential'));
});
