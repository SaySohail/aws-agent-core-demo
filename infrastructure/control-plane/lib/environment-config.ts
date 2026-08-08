export type EnvironmentName = 'dev' | 'prod';

export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly account: string;
  readonly region: string;
  readonly logRetentionDays: number;
  readonly noncurrentVersionRetentionDays: number;
  readonly pointInTimeRecovery: boolean;
  readonly removalPolicy: 'destroy' | 'retain';
  readonly webOrigin: string;
}

const VALID_ENVIRONMENTS: readonly EnvironmentName[] = ['dev', 'prod'];

function requiredSetting(
  environment: EnvironmentName,
  setting: 'ACCOUNT' | 'REGION' | 'WEB_ORIGIN'
): string {
  const value = process.env[`CONTROL_PLANE_${environment.toUpperCase()}_${setting}`];
  if (!value) {
    throw new Error(
      `CONTROL_PLANE_${environment.toUpperCase()}_${setting} must be set. ` +
        'The target account and region are intentionally never inferred from AWS credentials.'
    );
  }
  return value;
}

function requiredWebOrigin(environment: EnvironmentName): string {
  const value = requiredSetting(environment, 'WEB_ORIGIN');
  const origin = new URL(value);
  if (origin.origin !== value || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(
      `CONTROL_PLANE_${environment.toUpperCase()}_WEB_ORIGIN must be an origin without a path.`
    );
  }
  return origin.origin;
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
    removalPolicy: name === 'prod' ? 'retain' : 'destroy',
    webOrigin: requiredWebOrigin(name)
  };
}
