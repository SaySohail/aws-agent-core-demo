# Agent template infrastructure

Agent-specific Customer Support data-plane stack. It owns the AgentCore MCP Gateway, three
least-privilege Lambda targets, and an ephemeral demo support-data table; it does not modify or
own customer bootstrap roles, artifact storage, or KMS resources.

The Gateway requires `AWS_IAM` inbound authorization and its MCP targets retain
`GATEWAY_IAM_ROLE` outbound authorization. Its service role trusts AgentCore only for the current
account and Gateway ARN pattern, and can invoke only the three support-tool Lambda functions. It
does not have DynamoDB, IAM, or AgentCore administration permissions. There is no developer
Gateway-invoker role in this stack; production Gateway invocation is the Runtime Execution Role
model from customer bootstrap.

Run `pnpm --dir infrastructure/agent-template synth` after building workspace dependencies.
