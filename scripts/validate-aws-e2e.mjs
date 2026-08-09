import process from 'node:process';

/*
 * Cloud validation is deliberately opt-in. This guard is intentionally separate from the
 * runner so a local shell, CI job, or developer's default AWS profile can never create or
 * delete customer-account resources by accident.
 */
const required = [
  'AWS_E2E_CONTROL_PLANE_ACCOUNT_ID',
  'AWS_E2E_CUSTOMER_ACCOUNT_A_ID',
  'AWS_E2E_REGION',
  'AWS_E2E_RUN_ID'
];

if (process.env.AGENT_LAUNCHPAD_AWS_E2E !== '1') {
  throw new Error('Refusing cloud validation: set AGENT_LAUNCHPAD_AWS_E2E=1 explicitly.');
}
for (const name of required) {
  if (!process.env[name]) throw new Error(`Refusing cloud validation: ${name} is required.`);
}
for (const name of ['AWS_E2E_CONTROL_PLANE_ACCOUNT_ID', 'AWS_E2E_CUSTOMER_ACCOUNT_A_ID']) {
  if (!/^\d{12}$/.test(process.env[name]))
    throw new Error(`Refusing cloud validation: ${name} must be a 12-digit account ID.`);
}
if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(process.env.AWS_E2E_REGION))
  throw new Error('Refusing cloud validation: AWS_E2E_REGION is invalid.');
if (!/^[a-z0-9][a-z0-9-]{5,40}$/.test(process.env.AWS_E2E_RUN_ID))
  throw new Error('Refusing cloud validation: AWS_E2E_RUN_ID must be a safe unique run prefix.');

// The infrastructure currently has no agent-specific dependency provisioning/cleanup runner.
// Failing before any mutation is safer than simulating an end-to-end pass against an account.
throw new Error(
  'AWS E2E validation is blocked: agent-specific dependency provisioning and complete cleanup are not implemented. No AWS mutations were made.'
);
