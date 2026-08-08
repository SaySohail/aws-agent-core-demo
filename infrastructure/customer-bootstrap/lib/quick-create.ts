export interface QuickCreateParameters {
  readonly templateUrl: string;
  readonly trustedControlPlanePrincipalArn: string;
  readonly externalId: string;
  readonly stackName?: string;
}

/** Creates the CloudFormation console link used by the onboarding service after template publication. */
export const buildQuickCreateUrl = (parameters: QuickCreateParameters): string => {
  const query = new URLSearchParams({
    templateURL: parameters.templateUrl,
    stackName: parameters.stackName ?? 'AgentLaunchpadBootstrap',
    param_TrustedControlPlanePrincipalArn: parameters.trustedControlPlanePrincipalArn,
    param_ExternalId: parameters.externalId
  });

  return `https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?${query.toString()}`;
};
