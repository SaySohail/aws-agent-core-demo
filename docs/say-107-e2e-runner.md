# SAY-107 disposable-account runner

`pnpm validate:aws-e2e` is a destructive, opt-in release gate. It never discovers an account
from the current profile: it assumes each declared bootstrap role and verifies its returned STS
account ID before making an AgentCore control-plane request.

Run it only in disposable accounts with `AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES`.
The required target contract is `AWS_E2E_CUSTOMER_ACCOUNT_A_ID`,
`AWS_E2E_BOOTSTRAP_ROLE_A_ARN`, `AWS_E2E_EXTERNAL_ID_A`, `AWS_E2E_REGIONS`,
`AWS_E2E_REVOKED_BOOTSTRAP_ROLE_A_ARN`, and `AWS_E2E_MANIFEST`. Configure the corresponding B
variables for Tenant B. A one-account run remains `NOT READY`: it cannot prove true cross-account
tenant isolation.

The manifest is CI-secret material and is deliberately not committed. It contains a `cases` array
with one entry for every test ID in the generated validation report. Each entry supplies the concrete
deployed control-plane test URL, request method, optional non-secret headers/body, and either
`"expect": "success"` or `"expect": "denied"`. The runner rejects a manifest missing any case,
executes every request, accepts denials only as HTTP 401/403, and writes response-status evidence
to `docs/validation-report.md`. Fixture endpoints must perform the named operation against the
disposable deployment, including checking CloudWatch/CloudTrail/Lambda/DynamoDB/artifact/telemetry
for the no-credential-leak and no-refund-Lambda-execution cases.

This separation is intentional: browser auth tokens, test-driver URLs, and ExternalIds remain CI
secrets, while the verifier and its security matrix remain reviewable source.
