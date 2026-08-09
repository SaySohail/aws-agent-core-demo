import { GatewayMcpError, type GatewayMcpClient } from './gateway-mcp-client.js';
import { expectedGatewayToolNames } from './gateway-tool-names.js';
import type { ToolExecutionRequest, ToolExecutionResult, ToolExecutor } from './executor.js';
import type { ToolName } from './definitions.js';

export class GatewayToolExecutor implements ToolExecutor {
  private discovery?: Promise<Readonly<Record<ToolName, string>>>;
  public constructor(
    private readonly client: GatewayMcpClient,
    private readonly timeoutMs = 15_000
  ) {}

  public async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    try {
      const names = await this.resolveTools();
      const result = await this.client.callTool({
        name: names[request.name],
        arguments: request.input,
        requestId: request.requestId ?? crypto.randomUUID(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      return { status: 'success', data: result };
    } catch (error) {
      const code = this.errorCode(error);
      if (code === 'POLICY_DENIED') {
        const amountCents =
          request.name === 'process_refund' && 'amountCents' in request.input
            ? request.input.amountCents
            : undefined;
        console.info(
          JSON.stringify({
            event: 'policy_decision',
            invocationId: request.requestId,
            tool: request.name,
            decision: 'DENY',
            reasonCode: 'POLICY_DENIED',
            policyProfile: 'refund-auto-approval-v1',
            ...(amountCents === undefined ? {} : { amountCents })
          })
        );
      }
      return {
        status: 'error',
        code,
        message:
          code === 'POLICY_DENIED'
            ? 'This action requires manual approval.'
            : 'The support service could not complete the request.'
      };
    }
  }

  private async resolveTools(): Promise<Readonly<Record<ToolName, string>>> {
    this.discovery ??= this.discover();
    return this.discovery;
  }

  private async discover(): Promise<Readonly<Record<ToolName, string>>> {
    const tools = await this.client.listTools(AbortSignal.timeout(this.timeoutMs));
    const expected = expectedGatewayToolNames();
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of Object.keys(expected) as ToolName[]) {
      if (!names.has(expected[name])) throw new DiscoveryError();
    }
    if (
      tools.some(
        (tool) =>
          (Object.values(expected) as string[]).filter((name) => name === tool.name).length > 1
      )
    ) {
      throw new DiscoveryError();
    }
    return expected;
  }

  private errorCode(error: unknown): Extract<ToolExecutionResult, { status: 'error' }>['code'] {
    if (error instanceof DiscoveryError) return 'GATEWAY_TOOL_NOT_AVAILABLE';
    if (error instanceof GatewayMcpError) return error.code;
    if (error instanceof DOMException && error.name === 'TimeoutError') return 'TOOL_TIMEOUT';
    return 'TOOL_EXECUTION_ERROR';
  }
}

class DiscoveryError extends Error {}
