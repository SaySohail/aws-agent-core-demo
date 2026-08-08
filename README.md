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
