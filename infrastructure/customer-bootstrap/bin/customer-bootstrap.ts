import * as cdk from 'aws-cdk-lib';
import { CustomerBootstrapStack } from '../lib/customer-bootstrap-stack.js';

const app = new cdk.App();

new CustomerBootstrapStack(app, 'AgentLaunchpadCustomerBootstrap', {
  description: 'Agent Launchpad customer-account bootstrap contract v1'
});
