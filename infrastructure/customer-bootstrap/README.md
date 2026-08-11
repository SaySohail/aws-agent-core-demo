# Agent Launchpad customer bootstrap

This package produces the standalone CloudFormation template customers deploy in their own AWS
account. It creates only the customer bootstrap contract; it does not create an AgentCore runtime,
Gateway, policy engine, agent package, user, or access key.

## Deploying

Use the committed [`customer-bootstrap.template.json`](./customer-bootstrap.template.json), or
build it with `pnpm --dir infrastructure/customer-bootstrap run template`. The template requires:

- `TrustedControlPlanePrincipalArn`: exact IAM role ARN in the Agent Launchpad control-plane account.
- `TrustedDeploymentWorkerPrincipalArn`: exact deployment-worker IAM role ARN in the Agent Launchpad control-plane account.
- `ExternalId`: unique Agent Launchpad-generated AWS connection identifier used for STS
  confused-deputy protection. It is not a password or secret.

The control plane supplies those values and hosts a versioned template URL. Its Quick Create link
contract is:

```
https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=<url-encoded-hosted-template-url>&stackName=AgentLaunchpadBootstrap&param_TrustedControlPlanePrincipalArn=<url-encoded-arn>&param_TrustedDeploymentWorkerPrincipalArn=<url-encoded-arn>&param_ExternalId=<url-encoded-connection-id>
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

## One-time CloudWatch Transaction Search setup

AgentCore metrics continue to work without this setup, but Customer Support Runtime and Gateway
spans are searchable only after a customer account administrator enables CloudWatch Transaction
Search. This is deliberately not part of `AgentLaunchpadDeploymentRole` or the metrics-read path:
enabling it is an account-wide administrative change.

For a demo account, an administrator can use the CloudWatch console: **Application Signals / Transaction
Search**, enable Transaction Search, enable structured-log span ingestion, and wait until ingestion
is shown as enabled. Alternatively, after applying the required CloudWatch Logs resource policy,
run `aws xray update-trace-segment-destination --destination CloudWatchLogs`; AWS documents the
complete required policy and optional indexing rule. Use demo data only if application log delivery
is enabled: service application logs can contain request or response payloads and are never copied
into Agent Launchpad persistence or displayed to tenant users.

The product treats this prerequisite as `SETUP_REQUIRED`, separately from `CHECK_FAILED` and from
the normal `ENABLED` state; a missing trace is never interpreted as proof that no traces were
generated.

The deployment role has only `bedrock-agentcore:InvokeAgentRuntime` for Runtime data-plane calls;
it has no user-delegation or broad AgentCore invocation grant. Before an immutable Runtime ARN is
known, that grant is limited to Agent Launchpad-tagged Runtimes in this account and region. The
separate Runtime Execution Role can only invoke Agent Launchpad-tagged customer-support Gateways
in this account and region with `bedrock-agentcore:InvokeGateway`. Gateway identifiers are created
by the separate agent-template stack, so this tag-constrained pattern is the narrowest bootstrap-time
scope. Neither role carries Gateway administration permission.
