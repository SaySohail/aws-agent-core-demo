# SAY-107 validation report

## Result

**NOT READY**

Run: 2026-08-09T10:48:37.553Z. Target accounts: not configured; no AWS call was made. No account was selected implicitly.

| Gate | Result |
| --- | --- |
| Golden path | SKIPPED / NOT VALIDATED |
| Tenant isolation | SKIPPED / NOT VALIDATED |
| ExternalId | SKIPPED / NOT VALIDATED |
| Runtime IAM | SKIPPED / NOT VALIDATED |
| Gateway IAM | SKIPPED / NOT VALIDATED |
| Policy | SKIPPED / NOT VALIDATED |
| Deployment safety | SKIPPED / NOT VALIDATED |
| Rollback | SKIPPED / NOT VALIDATED |
| Cleanup isolation/recovery | SKIPPED / NOT VALIDATED |
| Credential leakage | SKIPPED / NOT VALIDATED |

## Evidence

| Test | Result | Evidence |
| --- | --- | --- |
| artifact_deployment | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| dependency_provisioning | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| runtime_ready | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| production_endpoint | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| playground_invocation | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| gateway_get_order | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| refund_policy_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| observability_evidence | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| second_runtime_version | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| rollback | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| undeploy | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| bootstrap_preserved | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| external_id_correct | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| external_id_missing_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| external_id_wrong_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| revoked_trust_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| runtime_unauthorized_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| runtime_unsigned_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| gateway_unauthorized_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| gateway_not_none | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| refund_threshold_denied_no_lambda | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| prompt_injection_refund_denied | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| tenant_a_cannot_access_b | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| deployment_idempotency | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| lifecycle_races | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| failed_candidate_not_production | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| rollback_failure_recovery | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| partial_cleanup_retry | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| agent_a_cleanup_preserves_b | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |
| no_credentials_leaked | SKIPPED / NOT VALIDATED | Refusing AWS E2E validation: set AGENT_LAUNCHPAD_AWS_E2E=DESTROY_DISPOSABLE_RESOURCES exactly. |

Critical findings open: 30

A `SKIPPED / NOT VALIDATED` result is not a pass. The command exits non-zero for any failed release-blocking test or incomplete required matrix.
