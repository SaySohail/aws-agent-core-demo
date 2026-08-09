export type EnvironmentName = 'dev' | 'prod';

export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly account: string;
  readonly region: string;
  readonly logRetentionDays: number;
  readonly noncurrentVersionRetentionDays: number;
  readonly pointInTimeRecovery: boolean;
  readonly removalPolicy: 'destroy' | 'retain';
  /** Explicit allow-list; never infer OAuth redirect destinations from the request. */
  readonly webOrigins: readonly string[];
  readonly customerBootstrapTemplateUrl: string;
  /** Versioned public template for one agent-owned dependency stack. */
  readonly agentDependencyTemplateUrl: string;
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

function requiredWebOrigins(environment: EnvironmentName): readonly string[] {
  const prefix = `CONTROL_PLANE_${environment.toUpperCase()}`;
  const values = (
    process.env[`${prefix}_WEB_ORIGINS`] ?? requiredSetting(environment, 'WEB_ORIGIN')
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length) throw new Error(`${prefix}_WEB_ORIGINS must include at least one origin.`);
  return [
    ...new Set(
      values.map((value) => {
        const origin = new URL(value);
        if (origin.origin !== value || origin.pathname !== '/' || origin.search || origin.hash)
          throw new Error(`${prefix}_WEB_ORIGINS entries must be origins without paths.`);
        if (
          origin.protocol !== 'https:' &&
          !(origin.protocol === 'http:' && origin.hostname === 'localhost')
        )
          throw new Error(`${prefix}_WEB_ORIGINS entries must use HTTPS, except localhost.`);
        return origin.origin;
      })
    )
  ];
}

function requiredHttpsSetting(
  environment: EnvironmentName,
  setting: 'CUSTOMER_BOOTSTRAP_TEMPLATE_URL' | 'AGENT_DEPENDENCY_TEMPLATE_URL'
): string {
  const value = process.env[`CONTROL_PLANE_${environment.toUpperCase()}_${setting}`];
  if (!value || new URL(value).protocol !== 'https:')
    throw new Error(`CONTROL_PLANE_${environment.toUpperCase()}_${setting} must be an HTTPS URL.`);
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
    removalPolicy: name === 'prod' ? 'retain' : 'destroy',
    webOrigins: requiredWebOrigins(name),
    customerBootstrapTemplateUrl: requiredHttpsSetting(name, 'CUSTOMER_BOOTSTRAP_TEMPLATE_URL'),
    agentDependencyTemplateUrl: requiredHttpsSetting(name, 'AGENT_DEPENDENCY_TEMPLATE_URL')
  };
}
