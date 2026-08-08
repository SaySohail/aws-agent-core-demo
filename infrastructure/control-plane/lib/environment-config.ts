export type EnvironmentName = 'dev' | 'prod';

export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly account: string;
  readonly region: string;
  readonly logRetentionDays: number;
  readonly noncurrentVersionRetentionDays: number;
  readonly pointInTimeRecovery: boolean;
  readonly removalPolicy: 'destroy' | 'retain';
}

const VALID_ENVIRONMENTS: readonly EnvironmentName[] = ['dev', 'prod'];

function requiredSetting(environment: EnvironmentName, setting: 'ACCOUNT' | 'REGION'): string {
  const value = process.env[`CONTROL_PLANE_${environment.toUpperCase()}_${setting}`];
  if (!value) {
    throw new Error(
      `CONTROL_PLANE_${environment.toUpperCase()}_${setting} must be set. ` +
        'The target account and region are intentionally never inferred from AWS credentials.'
    );
  }
  return value;
}

export function resolveEnvironmentConfig(environment: string): EnvironmentConfig {
  if (!VALID_ENVIRONMENTS.includes(environment as EnvironmentName)) {
    throw new Error(`Unsupported control-plane environment "${environment}". Use dev or prod.`);
  }
  const name = environment as EnvironmentName;
  return {
    name,
    account: requiredSetting(name, 'ACCOUNT'),
    region: requiredSetting(name, 'REGION'),
    logRetentionDays: name === 'prod' ? 365 : 14,
    noncurrentVersionRetentionDays: name === 'prod' ? 365 : 30,
    pointInTimeRecovery: name === 'prod',
    removalPolicy: name === 'prod' ? 'retain' : 'destroy'
  };
}
