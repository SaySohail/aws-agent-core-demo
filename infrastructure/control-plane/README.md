# Control-plane infrastructure

This CDK v2 application owns only shared control-plane resources. It deliberately does not create
customer-account resources, Cognito, AgentCore, or credentials. Customer setup remains isolated in
`../customer-bootstrap`.

## Prerequisites and target selection

Use Node 22 and pnpm from the repository root. Authenticate with your normal AWS mechanism (for
example AWS IAM Identity Center); never place long-lived access keys in this repository.

The target account and region are required environment variables, rather than being inferred from
the active AWS profile. Set the pair for the environment you will operate:

```sh
export CONTROL_PLANE_DEV_ACCOUNT=123456789012
export CONTROL_PLANE_DEV_REGION=ap-south-1
export CONTROL_PLANE_DEV_WEB_ORIGIN=http://localhost:3000
export CONTROL_PLANE_DEV_CUSTOMER_BOOTSTRAP_TEMPLATE_URL=https://assets.example.com/agent-launchpad/customer-bootstrap.template.json
export CONTROL_PLANE_PROD_ACCOUNT=210987654321
export CONTROL_PLANE_PROD_REGION=ap-south-1
export CONTROL_PLANE_PROD_WEB_ORIGIN=https://app.example.com
export CONTROL_PLANE_PROD_CUSTOMER_BOOTSTRAP_TEMPLATE_URL=https://assets.example.com/agent-launchpad/customer-bootstrap.template.json
```

## Deployment workflow

Install from the repository root, then bootstrap each explicit account/region pair once:

```sh
pnpm install --frozen-lockfile
pnpm --dir infrastructure/control-plane exec cdk bootstrap aws://$CONTROL_PLANE_DEV_ACCOUNT/$CONTROL_PLANE_DEV_REGION
pnpm --dir infrastructure/control-plane synth
pnpm --dir infrastructure/control-plane diff
pnpm --dir infrastructure/control-plane deploy:dev
```

For production, substitute the `PROD` variables and pass `-c environment=prod`. Run `synth` before
the local `diff` script; it compares the generated template to the local assembly and therefore
does not require AWS credentials. To compare against a deployed stack, use `cdk diff` while
authenticated to that same explicit account and region.

Destroy only the development stack when it is no longer needed:

```sh
pnpm --dir infrastructure/control-plane destroy:dev
```

Development data and artifact versions are removed predictably with the stack. Production tables,
logs, and buckets use `RETAIN`, and the DynamoDB table enables point-in-time recovery. Bucket
versioning, encrypted storage, Block Public Access, TLS-only access, and lifecycle cleanup are
configured in both environments.

## Resources and outputs

The stack provisions an HTTP API with public `GET /health` and JWT-protected `GET /me`, Node.js 22
TypeScript Lambdas and restricted CloudWatch Logs roles, a pay-per-request DynamoDB table using generic
`pk`/`sk` keys, and an artifact bucket. The table additionally has `MembershipsByUser`
(`gsi1pk`/`gsi1sk`) for `USER#<cognitoSub>` to `TENANT#<tenantId>` membership queries, and
`DeploymentsByAgent` (`gsi2pk`/`gsi2sk`) for chronological deployment queries using
`TENANT#<tenantId>#AGENT#<agentId>` and `<createdAt>#<deploymentId>`. It also provisions a
Cognito User Pool with public sign-up disabled, a browser-safe Authorization Code + PKCE client
(no client secret), and a Cognito domain.
The configured browser origin is the only callback and logout origin. Outputs expose the API endpoint,
table name, bucket name, and Cognito values required by the web app. Every supported resource is tagged
with `Project`, `Environment`, `ManagedBy`, and `Plane`.

The bootstrap template URL is a deployment-time trusted value. The API creates its Quick Create URL
from that setting, the control API execution-role ARN, and a server-generated per-connection ExternalId;
it never accepts a template location or role ARN from the browser. The API role can assume only the
customer bootstrap role pattern `AgentLaunchpadDeploymentRole`; the customer role independently checks
the exact principal and ExternalId.
