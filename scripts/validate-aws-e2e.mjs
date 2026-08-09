/* global URL, console */
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand
} from '@aws-sdk/client-bedrock-agentcore-control';

const reportPath = new URL('../docs/validation-report.md', import.meta.url);
const requiredCases = [
  ['artifact_deployment', 'Golden path'],
  ['dependency_provisioning', 'Golden path'],
  ['runtime_ready', 'Golden path'],
  ['production_endpoint', 'Golden path'],
  ['playground_invocation', 'Golden path'],
  ['gateway_get_order', 'Golden path'],
  ['refund_policy_denied', 'Policy'],
  ['observability_evidence', 'Golden path'],
  ['second_runtime_version', 'Golden path'],
  ['rollback', 'Rollback'],
  ['undeploy', 'Cleanup isolation/recovery'],
  ['bootstrap_preserved', 'Cleanup isolation/recovery'],
  ['external_id_correct', 'ExternalId'],
  ['external_id_missing_denied', 'ExternalId'],
  ['external_id_wrong_denied', 'ExternalId'],
  ['revoked_trust_denied', 'ExternalId'],
  ['runtime_unauthorized_denied', 'Runtime IAM'],
  ['runtime_unsigned_denied', 'Runtime IAM'],
  ['gateway_unauthorized_denied', 'Gateway IAM'],
  ['gateway_not_none', 'Gateway IAM'],
  ['refund_threshold_denied_no_lambda', 'Policy'],
  ['prompt_injection_refund_denied', 'Policy'],
  ['tenant_a_cannot_access_b', 'Tenant isolation'],
  ['deployment_idempotency', 'Deployment safety'],
  ['lifecycle_races', 'Deployment safety'],
  ['failed_candidate_not_production', 'Deployment safety'],
  ['rollback_failure_recovery', 'Rollback'],
  ['partial_cleanup_retry', 'Cleanup isolation/recovery'],
  ['agent_a_cleanup_preserves_b', 'Cleanup isolation/recovery'],
  ['no_credentials_leaked', 'Credential leakage']
];
const blockingCategories = [
  'Golden path',
  'Tenant isolation',
  'ExternalId',
  'Runtime IAM',
  'Gateway IAM',
  'Policy',
  'Deployment safety',
  'Rollback',
  'Cleanup isolation/recovery',
  'Credential leakage'
];

function fail(message) {
  throw new Error(`Refusing AWS E2E validation: ${message}`);
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}
function account(name) {
  const value = required(name);
  if (!/^\d{12}$/.test(value)) fail(`${name} must be a 12-digit AWS account ID.`);
  return value;
}
function role(name, accountId) {
  const value = required(name);
  if (!new RegExp(`^arn:aws:iam::${accountId}:role/[A-Za-z0-9+=,.@_/-]+$`).test(value))
    fail(`${name} must be an IAM role ARN in the explicitly configured account.`);
  return value;
}
function regions() {
  const values = required('AWS_E2E_REGIONS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length || values.some((value) => !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)))
    fail('AWS_E2E_REGIONS must be a comma-separated list of valid Regions.');
  return [...new Set(values)];
}
function configuredTargets() {
  if (process.env.AGENT_LAUNCHPAD_AWS_E2E !== 'DESTROY_DISPOSABLE_RESOURCES')
    fail('set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly.');
  const controlPlaneAccountId = account('AWS_E2E_CONTROL_PLANE_ACCOUNT_ID');
  const stage = required('AWS_E2E_STAGE');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(stage))
    fail('AWS_E2E_STAGE must be an explicit safe environment/stage name.');
  const regionList = regions();
  const tenantA = {
    tenant: 'A',
    accountId: account('AWS_E2E_CUSTOMER_ACCOUNT_A_ID'),
    roleArn: undefined,
    externalId: required('AWS_E2E_EXTERNAL_ID_A')
  };
  tenantA.roleArn = role('AWS_E2E_BOOTSTRAP_ROLE_A_ARN', tenantA.accountId);
  const tenantB = process.env.AWS_E2E_CUSTOMER_ACCOUNT_B_ID?.trim()
    ? {
        tenant: 'B',
        accountId: account('AWS_E2E_CUSTOMER_ACCOUNT_B_ID'),
        roleArn: undefined,
        externalId: required('AWS_E2E_EXTERNAL_ID_B')
      }
    : undefined;
  if (tenantB) tenantB.roleArn = role('AWS_E2E_BOOTSTRAP_ROLE_B_ARN', tenantB.accountId);
  return {
    controlPlaneAccountId,
    regionList,
    stage,
    tenants: tenantB ? [tenantA, tenantB] : [tenantA]
  };
}

async function assumeExact(target, externalId) {
  const client = new STSClient({ region: 'us-east-1' });
  const response = await client.send(
    new AssumeRoleCommand({
      RoleArn: target.roleArn,
      RoleSessionName: `say107-${target.tenant}-${Date.now()}`,
      ExternalId: externalId
    })
  );
  if (!response.Credentials) throw new Error('STS did not return disposable-account credentials.');
  const credentials = {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken
  };
  const identity = await new STSClient({ region: 'us-east-1', credentials }).send(
    new GetCallerIdentityCommand({})
  );
  if (identity.Account !== target.accountId)
    throw new Error(
      `AssumeRole returned ${identity.Account ?? 'no account'}, not configured account ${target.accountId}.`
    );
  return credentials;
}
async function expectAssumeDenied(target, externalId) {
  try {
    await assumeExact(target, externalId);
    return false;
  } catch (error) {
    return /AccessDenied|Forbidden|Unauthorized/i.test(error instanceof Error ? error.name : '');
  }
}
function render(results, targetInfo) {
  const groups = new Map(blockingCategories.map((category) => [category, []]));
  for (const result of results) groups.get(result.category)?.push(result);
  const categoryStatus = (category) => {
    const values = groups.get(category) ?? [];
    if (values.some((value) => value.status === 'FAIL')) return 'FAIL';
    if (values.some((value) => value.status !== 'PASS')) return 'SKIPPED / NOT VALIDATED';
    return 'PASS';
  };
  const findings = results.filter((value) => value.status !== 'PASS').length;
  const failures = results.filter((value) => value.status === 'FAIL').length;
  const title = failures
    ? 'NOT READY'
    : results.length === requiredCases.length && results.every((value) => value.status === 'PASS')
      ? 'READY'
      : 'NOT READY';
  const lines = [
    '# SAY-107 validation report',
    '',
    '## Result',
    '',
    `**${title}**`,
    '',
    `Run: ${new Date().toISOString()}. Target accounts: ${targetInfo}. No account was selected implicitly.`,
    '',
    '| Gate | Result |',
    '| --- | --- |'
  ];
  for (const category of blockingCategories)
    lines.push(`| ${category} | ${categoryStatus(category)} |`);
  lines.push('', '## Evidence', '', '| Test | Result | Evidence |', '| --- | --- | --- |');
  for (const result of results)
    lines.push(`| ${result.id} | ${result.status} | ${result.detail} |`);
  lines.push(
    '',
    `Critical findings open: ${findings}`,
    '',
    'A `SKIPPED / NOT VALIDATED` result is not a pass. The command exits non-zero for any failed release-blocking test or incomplete required matrix.'
  );
  return lines.join('\n') + '\n';
}

const results = [];
try {
  const targets = configuredTargets();
  const credentials = new Map();
  for (const target of targets.tenants) {
    credentials.set(target.tenant, await assumeExact(target, target.externalId));
    results.push({
      id: `assume_role_${target.tenant.toLowerCase()}`,
      category: 'Golden path',
      status: 'PASS',
      detail: `AssumeRole identity matches account ${target.accountId}.`
    });
  }
  const a = targets.tenants[0];
  results.push({
    id: 'external_id_correct',
    category: 'ExternalId',
    status: 'PASS',
    detail: 'AssumeRole with the configured ExternalId returned the expected account.'
  });
  for (const [id, externalId] of [
    ['external_id_missing_denied', undefined],
    ['external_id_wrong_denied', `${a.externalId}-wrong`]
  ]) {
    results.push({
      id,
      category: 'ExternalId',
      status: (await expectAssumeDenied(a, externalId)) ? 'PASS' : 'FAIL',
      detail: 'STS AssumeRole denial assertion.'
    });
  }
  const revoked = process.env.AWS_E2E_REVOKED_BOOTSTRAP_ROLE_A_ARN?.trim();
  if (!revoked)
    fail('AWS_E2E_REVOKED_BOOTSTRAP_ROLE_A_ARN is required for revoked-trust evidence.');
  results.push({
    id: 'revoked_trust_denied',
    category: 'ExternalId',
    status: (await expectAssumeDenied({ ...a, roleArn: revoked }, a.externalId)) ? 'PASS' : 'FAIL',
    detail: 'Explicit revoked-trust role denial assertion.'
  });
  for (const target of targets.tenants)
    for (const region of targets.regionList) {
      await new BedrockAgentCoreControlClient({
        region,
        credentials: credentials.get(target.tenant),
        maxAttempts: 1
      }).send(new ListAgentRuntimesCommand({ maxResults: 1 }));
    }
  for (const [id, category] of requiredCases) {
    if (results.some((result) => result.id === id)) continue;
    if (id === 'tenant_a_cannot_access_b' && targets.tenants.length < 2) {
      results.push({
        id,
        category,
        status: 'SKIPPED / NOT VALIDATED',
        detail:
          'Only Tenant A / one customer account is configured; true cross-account isolation was not validated.'
      });
      continue;
    }
    results.push({
      id,
      category,
      status: 'SKIPPED / NOT VALIDATED',
      detail:
        'Direct AWS validation implementation is required; generic HTTP manifests are rejected.'
    });
  }
  const targetInfo =
    targets.tenants.map((target) => `Tenant ${target.tenant} → ${target.accountId}`).join('; ') +
    (targets.tenants.length === 1
      ? ' (single account: true cross-account isolation NOT VALIDATED)'
      : '');
  await writeFile(reportPath, render(results, targetInfo));
  const failures = results.filter((result) => result.status !== 'PASS');
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : 'configuration failed';
  const skipped = requiredCases.map(([id, category]) => ({
    id,
    category,
    status: 'SKIPPED / NOT VALIDATED',
    detail: message
  }));
  await writeFile(reportPath, render(skipped, 'not configured; no AWS call was made'));
  console.error(message);
  process.exitCode = 1;
}
