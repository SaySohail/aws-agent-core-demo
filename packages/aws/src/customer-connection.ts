import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export const CUSTOMER_BOOTSTRAP_VERSION = '1';
export const CUSTOMER_DEPLOYMENT_ROLE_NAME = 'AgentLaunchpadDeploymentRole';
export const CUSTOMER_BOOTSTRAP_STACK_NAME = 'AgentLaunchpadBootstrap';

export function customerDeploymentRoleArn(accountId: string, partition = 'aws'): string {
  if (!/^\d{12}$/.test(accountId))
    throw new Error('AWS account ID must contain exactly 12 digits.');
  if (partition !== 'aws') throw new Error('Only the commercial AWS partition is supported.');
  return `arn:aws:iam::${accountId}:role/${CUSTOMER_DEPLOYMENT_ROLE_NAME}`;
}

/** Matches the deterministic bucket name exported by customer bootstrap contract v1. */
export function customerArtifactBucketName(accountId: string, region: string): string {
  if (!/^\d{12}$/.test(accountId) || !/^[a-z]{2}-[a-z]+-\d$/.test(region))
    throw new Error('Invalid customer bootstrap resource coordinates.');
  return `agent-launchpad-artifacts-${accountId}-${region}`;
}

export function buildCustomerBootstrapQuickCreateUrl(input: {
  readonly region: string;
  readonly templateUrl: string;
  readonly trustedControlPlanePrincipalArn: string;
  readonly externalId: string;
}): string {
  const template = new URL(input.templateUrl);
  if (template.protocol !== 'https:') throw new Error('Bootstrap template URL must use HTTPS.');
  const query = new URLSearchParams({
    templateURL: template.toString(),
    stackName: CUSTOMER_BOOTSTRAP_STACK_NAME,
    param_TrustedControlPlanePrincipalArn: input.trustedControlPlanePrincipalArn,
    param_ExternalId: input.externalId
  });
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(input.region)}#/stacks/create/review?${query.toString()}`;
}

export interface AssumedCustomerRoleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export interface CustomerRoleAssumer {
  assumeCustomerRole(input: {
    readonly roleArn: string;
    readonly externalId: string;
    readonly sessionName: string;
  }): Promise<AssumedCustomerRoleCredentials>;
  getCallerIdentity(
    credentials: AssumedCustomerRoleCredentials
  ): Promise<{ account?: string; arn?: string }>;
  headArtifactBucket(
    credentials: AssumedCustomerRoleCredentials,
    bucketName: string,
    region: string
  ): Promise<void>;
}

/**
 * Temporary credentials are deliberately returned only to server-side callers and are never persisted.
 * VERIFIED records a past trust check only; every later operation must assume the role again.
 */
export class StsCustomerRoleAssumer implements CustomerRoleAssumer {
  public constructor(private readonly sts = new STSClient({})) {}

  async assumeCustomerRole(input: {
    readonly roleArn: string;
    readonly externalId: string;
    readonly sessionName: string;
  }): Promise<AssumedCustomerRoleCredentials> {
    if (!input.roleArn || !input.externalId || !input.sessionName)
      throw new Error('Missing role assumption input.');
    const result = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: input.roleArn,
        ExternalId: input.externalId,
        RoleSessionName: input.sessionName,
        DurationSeconds: 900
      })
    );
    const credentials = result.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken)
      throw new Error('STS did not return complete temporary credentials.');
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken
    };
  }

  async getCallerIdentity(credentials: AssumedCustomerRoleCredentials) {
    const client = new STSClient({ credentials });
    const identity = await client.send(new GetCallerIdentityCommand({}));
    return {
      ...(identity.Account ? { account: identity.Account } : {}),
      ...(identity.Arn ? { arn: identity.Arn } : {})
    };
  }

  async headArtifactBucket(
    credentials: AssumedCustomerRoleCredentials,
    bucketName: string,
    region: string
  ): Promise<void> {
    await new S3Client({ region, credentials }).send(new HeadBucketCommand({ Bucket: bucketName }));
  }
}
