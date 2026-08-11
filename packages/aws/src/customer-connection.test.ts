import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCustomerBootstrapQuickCreateUrl,
  customerArtifactBucketName,
  customerDeploymentRoleArn
} from './customer-connection.js';

test('bootstrap v1 URLs use only the trusted template and connection coordinates', () => {
  const url = buildCustomerBootstrapQuickCreateUrl({
    region: 'us-east-1',
    templateUrl: 'https://assets.example.test/bootstrap.json',
    trustedControlPlanePrincipalArn: 'arn:aws:iam::111111111111:role/ControlApi',
    trustedDeploymentWorkerPrincipalArn: 'arn:aws:iam::111111111111:role/DeploymentWorker',
    externalId: 'per-connection-id'
  });
  assert.match(
    url,
    /^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudformation\/home\?region=us-east-1#/
  );
  assert.match(url, /templateURL=https%3A%2F%2Fassets\.example\.test%2Fbootstrap\.json/);
  assert.match(url, /param_ExternalId=per-connection-id/);
  assert.match(url, /param_TrustedDeploymentWorkerPrincipalArn=arn%3Aaws%3Aiam/);
  assert.equal(
    customerDeploymentRoleArn('123456789012'),
    'arn:aws:iam::123456789012:role/AgentLaunchpadDeploymentRole'
  );
  assert.equal(
    customerArtifactBucketName('123456789012', 'us-east-1'),
    'agent-launchpad-artifacts-123456789012-us-east-1'
  );
  assert.throws(() => customerDeploymentRoleArn('not-an-account'));
});
