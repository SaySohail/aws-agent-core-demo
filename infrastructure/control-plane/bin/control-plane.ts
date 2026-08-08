import * as cdk from 'aws-cdk-lib';
import { ControlPlaneStack } from '../lib/control-plane-stack';
import { resolveEnvironmentConfig } from '../lib/environment-config';

const app = new cdk.App();
const environmentName =
  app.node.tryGetContext('environment') ?? process.env.CONTROL_PLANE_ENV ?? 'dev';
const configuration = resolveEnvironmentConfig(environmentName);

new ControlPlaneStack(app, `ControlPlane-${configuration.name}`, {
  description: `Agent Launchpad control plane (${configuration.name})`,
  env: { account: configuration.account, region: configuration.region },
  configuration
});
