import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('cdk.out/AgentLaunchpadCustomerBootstrap.template.json');
const destination = resolve('customer-bootstrap.template.json');
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
