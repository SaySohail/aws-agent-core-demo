import * as cdk from 'aws-cdk-lib';
import { CustomerSupportToolsStack } from '../lib/customer-support-tools-stack.js';

const app = new cdk.App();
new CustomerSupportToolsStack(app, 'AgentLaunchpadCustomerSupportTools');
