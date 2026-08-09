# SAY-107 validation report

## Result

**FAIL — release/security gate is not approved.**

This remains fail-closed: no explicitly identified disposable cloud accounts, test users, or
bootstrap identifiers were supplied to execute the real AWS gate. A skipped cloud run is not PASS.

This report records a local validation run of revision
`e302c1f827d89615db8c93699691b6eb709a8a84` on 2026-08-09 (Asia/Calcutta).
No AWS customer account, Cognito development user, CloudTrail trail, or disposable
control-plane environment was configured. No cloud resources were created, updated, or deleted.

## Automated evidence

| Category                  | Result                | Evidence                                                                                                                                             |
| ------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package/install integrity | PASS                  | `pnpm install --frozen-lockfile`                                                                                                                     |
| Lint                      | PASS                  | `pnpm lint`                                                                                                                                          |
| Type safety               | PASS                  | `pnpm typecheck`                                                                                                                                     |
| Unit/security tests       | PASS                  | `pnpm test`, `pnpm validate:security`                                                                                                                |
| Build                     | PASS                  | `pnpm build`                                                                                                                                         |
| CDK synthesis             | PASS                  | Bootstrap and agent-template synth; control-plane synth with explicit non-production placeholder account, Region, origin, and bootstrap-template URL |
| Formatting                | PASS                  | `pnpm format:check`                                                                                                                                  |
| AWS E2E                   | NOT RUN / FAIL-CLOSED | `pnpm validate:aws-e2e` refused because `AGENT_LAUNCHPAD_AWS_E2E=1` and required disposable-account identifiers were not supplied                    |

The local suite exercises tenant-partitioned repository/API reads, server-owned connection
coordinates, idempotent deploy requests, lifecycle locking, artifact reproducibility and
ZIP inspection, MMDSv2 request configuration, production endpoint qualification, IAM/SigV4
invoker construction, policy-denial handling, tool-input validation, side-effect idempotency,
observability fail-open behavior, and synthesized bootstrap/Gateway IAM and Cedar assertions.

## Security finding fixed

**ExternalId-bearing bootstrap URL persisted in verified browser responses — fixed.**

The control API previously generated `quickCreateUrl` for every connection state. That URL includes
the CloudFormation ExternalId parameter and therefore exposed the ExternalId again after successful
onboarding. Verified connection responses now omit `quickCreateUrl`; the URL is only returned while
the connection is pending bootstrap. The API regression test proves the verified response contains
neither `quickCreateUrl` nor the ExternalId.

## Cloud validation prerequisites and limitations

`pnpm validate:aws-e2e` requires all of the following before it will do anything:

- `AGENT_LAUNCHPAD_AWS_E2E=1`
- `AWS_E2E_CONTROL_PLANE_ACCOUNT_ID`
- `AWS_E2E_CUSTOMER_ACCOUNT_A_ID`
- `AWS_E2E_REGION`
- `AWS_E2E_RUN_ID`

It currently stops before mutation even with those settings. The checked-out implementation has no
complete agent-specific dependency provisioner or cleanup implementation: dependency-stack identity
is not persistently owned, and undeploy intentionally rejects dependency/artifact stages with
`UNDEPLOY_PLAN_INCOMPLETE`. Therefore it cannot safely validate the required clean golden path,
two-agent teardown preservation, or partial-cleanup recovery. Treating mocked paths as cloud proof
would be misleading.

No true Tenant A → Account A / Tenant B → Account B isolation result is claimed. The following
release-blocking evidence remains uncollected against real identities/resources: STS wrong/missing
ExternalId denial; revoked trust fail-closed deploy/invoke/rollback/undeploy; unsigned and unrelated
IAM Runtime/Gateway denial; policy engine side-effect denial; immutable S3 VersionId deployment;
candidate/rollback failure compensation; CloudTrail evidence; and cleanup ownership attacks.

## Required follow-up before release

1. Finish persisted agent dependency provisioning and ownership-validated cleanup.
2. Implement the explicit AWS E2E runner using two disposable customer accounts (or document a
   single-account, separate-role emulation) and the required non-secret environment contract.
3. Run the complete SAY-107 matrix, preserving only request IDs/timestamps/identity summaries in
   its evidence.
4. Resolve the existing workspace formatting failures, then rerun the command matrix.

Until those items are complete, SAY-107 must remain **FAIL** and must not be used as release approval.

## Runtime networking decision

AgentCore Runtime currently uses `PUBLIC` networking intentionally for the demo: the managed Runtime
needs a public service endpoint and does not receive browser traffic. Inbound invocation remains
restricted to AWS IAM/SigV4; the application invokes only from the server using short-lived customer
role credentials, validates the Runtime ARN against the connected account and Region, and prohibits
browser/JWT/user-delegated Runtime invocation. `PUBLIC` therefore means network reachability, not
anonymous access. The tradeoff is that this is not private VPC isolation; it remains appropriate only
while the IAM-only demo threat model is accepted. No VPC change was made because no authorization
defect was found.
