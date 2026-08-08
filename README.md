# Agent Launchpad

Production-ready monorepo foundation for launching agents. The control-plane baseline is defined in
AWS CDK; AgentCore and customer-account deployment logic are intentionally not implemented yet.

## Requirements

- Node.js `22.23.0` (pinned in `.nvmrc` and `.node-version`)
- pnpm `11.18.0` (pinned in `package.json`)

Enable Corepack if pnpm is not already available: `corepack enable`.

## Setup

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm dev
```

Copy `.env.example` to `apps/web/.env.local` before adding local web configuration. Next.js runs
from that workspace, so it does not load a root `.env` file. The example has no secrets; environment
parsing is centralized in `@agent-launchpad/shared`.

## Commands

- `pnpm dev` — run the Next.js web app.
- `pnpm lint` — lint every workspace from the repository root.
- `pnpm format:check` — check Prettier formatting.
- `pnpm typecheck` — run strict TypeScript checks in all workspaces.
- `pnpm build` — build all compilable workspaces in dependency order.

## Structure

```text
apps/web                         Next.js operator interface
services/control-api             future control API boundary
services/deployment-worker       future asynchronous deployment boundary
agents/customer-support          independently compilable agent template
packages/schemas                 validated contracts shared across boundaries
packages/aws                     server-only AWS helper boundary
packages/shared                  environment and cross-cutting shared utilities
infrastructure/control-plane     standalone CDK control-plane baseline
infrastructure/customer-bootstrap reserved customer bootstrap module
infrastructure/agent-template    reserved reusable agent infrastructure module
```

See [`infrastructure/control-plane/README.md`](infrastructure/control-plane/README.md) for the CDK
bootstrap, synth, diff, deploy, and destroy workflow. Customer bootstrap and agent-template
infrastructure remain separate placeholders. The AWS package does not expose browser-compatible
credential helpers.

## Local control-plane API

Docker Desktop can run the complete persistence and HTTP boundary locally; AWS credentials and a
Cognito account are not required. The local adapter is deliberately separate from the Lambda handler
and only starts when `LOCAL_CONTROL_API=1`. It listens on loopback and uses `X-Local-User-Id` strictly
as a development identity substitute; deployed routes still require API Gateway's validated JWT.

```powershell
docker compose up -d dynamodb-local
pnpm --filter @agent-launchpad/control-api local:reset
$env:LOCAL_CONTROL_API = '1'
$env:CONTROL_API_PORT = '4000'
pnpm --filter @agent-launchpad/control-api local:serve
```

The reset command creates the same DynamoDB table/index shape as CDK and seeds two active tenants,
an active template, and one same-ID draft agent in each tenant. It is safe to run repeatedly and
only affects Docker's `dynamodb-local-data` volume.

In a second PowerShell window, exercise the API:

```powershell
$base = 'http://127.0.0.1:4000'
$tenantA = 'tnt_00000000-0000-4000-8000-000000000001'
$tenantB = 'tnt_00000000-0000-4000-8000-000000000002'

curl.exe "$base/health"
curl.exe "$base/tenants" -H 'X-Local-User-Id: user-a'
curl.exe "$base/tenants/$tenantA/agents" -H 'X-Local-User-Id: user-a'
curl.exe "$base/tenants/$tenantB/agents" -H 'X-Local-User-Id: user-a'
```

The final request returns `403` and exposes no Tenant B data. `user-a` is an ADMIN of Tenant A;
`user-b` is a MEMBER of Tenant B. To reset local state, run `local:reset`; to stop only the database,
run `docker compose down`. Run `docker compose down -v` only when you intentionally want to delete
the local DynamoDB data volume.
