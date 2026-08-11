/* eslint-disable @typescript-eslint/no-explicit-any -- synthesized CloudFormation is dynamic JSON. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ControlPlaneStack } from '../lib/control-plane-stack.js';
import type { EnvironmentConfig } from '../lib/environment-config.js';

const configuration: EnvironmentConfig = {
  name: 'dev',
  account: '111111111111',
  region: 'us-east-1',
  logRetentionDays: 14,
  noncurrentVersionRetentionDays: 30,
  pointInTimeRecovery: false,
  removalPolicy: 'destroy',
  webOrigins: ['http://localhost:3000'],
  customerBootstrapTemplateUrl: 'https://example.invalid/bootstrap.yaml',
  agentDependencyTemplateUrl: 'https://example.invalid/dependencies.yaml'
};

test('synthesizes closed lifecycle branches and operation-bearing worker tasks', () => {
  const app = new cdk.App();
  const stack = new ControlPlaneStack(app, 'LifecycleContract', { configuration });
  const template = Template.fromStack(stack).toJSON();
  const stateMachine = Object.values(template.Resources as Record<string, any>).find(
    (resource) => resource.Type === 'AWS::StepFunctions::StateMachine'
  );
  assert.ok(stateMachine);
  const definition = JSON.stringify(stateMachine.Properties.DefinitionString);
  for (const operation of ['DEPLOY', 'ROLLBACK', 'UNDEPLOY'])
    assert.match(definition, new RegExp(operation));
  for (const stage of [
    'ROLLBACK_VALIDATING',
    'ROLLBACK_VERIFYING_TARGET',
    'ROLLBACK_UPDATING_ENDPOINT',
    'ROLLBACK_WAITING_FOR_ENDPOINT',
    'ROLLBACK_HEALTH_CHECKING',
    'ROLLBACK_REVERTING_ENDPOINT',
    'UNDEPLOY_VALIDATING',
    'UNDEPLOY_VERIFYING'
  ])
    assert.match(definition, new RegExp(stage));
  assert.match(definition, /operationType\.\$/);
  assert.doesNotMatch(definition, /artifactId\.\$/);
  assert.match(definition, /Deployment\.Transient/);
  assert.match(definition, /InvalidLifecycleOperation/);
});
