# Agent Launchpad customer bootstrap

This package produces the standalone CloudFormation template customers deploy in their own AWS
account. It creates only the customer bootstrap contract; it does not create an AgentCore runtime,
Gateway, policy engine, agent package, user, or access key.

## Deploying

Use the committed [`customer-bootstrap.template.json`](./customer-bootstrap.template.json), or
build it with `pnpm --dir infrastructure/customer-bootstrap run template`. The template requires:

- `TrustedControlPlanePrincipalArn`: exact IAM role ARN in the Agent Launchpad control-plane account.
- `ExternalId`: unique Agent Launchpad-generated AWS connection identifier used for STS
  confused-deputy protection. It is not a password or secret.

The control plane supplies those values and hosts a versioned template URL. Its Quick Create link
contract is:

```
https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=<url-encoded-hosted-template-url>&stackName=AgentLaunchpadBootstrap&param_TrustedControlPlanePrincipalArn=<url-encoded-arn>&param_ExternalId=<url-encoded-connection-id>
```

`buildQuickCreateUrl` in `lib/quick-create.ts` constructs that URL once the template publisher
provides the hosted template URL. Customers do not need CDK or this repository.

## Lifecycle and security

The artifact bucket and KMS key use `Retain` on stack deletion. This conservative demo/default
preserves encrypted artifacts and avoids an accidental key deletion making retained data unreadable;
customers clean them up intentionally after confirming they are no longer needed. Roles delete with
the stack. Bucket access is TLS-only, versioned, KMS-encrypted, and public access is blocked.

The only wildcard resources are documented inline in the synthesized policies: AgentCore create/list
operations and X-Ray/CloudWatch metrics do not support a narrower resource ARN. Their action lists
are deliberately small; metrics are constrained to the `bedrock-agentcore` namespace.

The deployment role has only `bedrock-agentcore:InvokeAgentRuntime` for Runtime data-plane calls;
it has no user-delegation or broad AgentCore invocation grant. Before an immutable Runtime ARN is
known, that grant is limited to Agent Launchpad-tagged Runtimes in this account and region. The
separate Runtime Execution Role can only invoke Agent Launchpad-tagged customer-support Gateways
in this account and region with `bedrock-agentcore:InvokeGateway`. Gateway identifiers are created
by the separate agent-template stack, so this tag-constrained pattern is the narrowest bootstrap-time
scope. Neither role carries Gateway administration permission.
