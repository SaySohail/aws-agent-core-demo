# Agent template infrastructure

Agent-specific Customer Support data-plane stack. It owns the AgentCore MCP Gateway, three
least-privilege Lambda targets, and an ephemeral demo support-data table; it does not modify or
own customer bootstrap roles, artifact storage, or KMS resources.

Run `pnpm --dir infrastructure/agent-template synth` after building workspace dependencies.
