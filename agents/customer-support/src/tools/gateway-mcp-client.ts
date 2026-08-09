import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { MCP_PROTOCOL_VERSION } from './gateway-tool-names.js';

export interface GatewayMcpTransport {
  post(body: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
}

export interface GatewayTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface GatewayMcpClient {
  listTools(signal?: AbortSignal): Promise<readonly GatewayTool[]>;
  callTool(input: {
    readonly name: string;
    readonly arguments: unknown;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export class HttpGatewayMcpClient implements GatewayMcpClient {
  public constructor(private readonly transport: GatewayMcpTransport) {}

  public async listTools(signal?: AbortSignal): Promise<readonly GatewayTool[]> {
    const result = await this.request('tools/list', {}, 'gateway-tools-list', signal);
    if (
      !result ||
      typeof result !== 'object' ||
      !Array.isArray((result as { tools?: unknown }).tools)
    ) {
      throw new GatewayMcpError('GATEWAY_INVALID_RESPONSE');
    }
    return (result as { tools: GatewayTool[] }).tools;
  }

  public async callTool(input: {
    readonly name: string;
    readonly arguments: unknown;
    readonly requestId: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    return this.request(
      'tools/call',
      { name: input.name, arguments: input.arguments },
      input.requestId,
      input.signal
    );
  }

  private async request(
    method: string,
    params: unknown,
    id: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await this.transport.post({ jsonrpc: '2.0', id, method, params }, signal);
    if (response.status === 401 || response.status === 403)
      throw new GatewayMcpError('GATEWAY_UNAUTHORIZED');
    if (response.status >= 500) throw new GatewayMcpError('GATEWAY_UNAVAILABLE');
    if (response.status >= 400) throw new GatewayMcpError('GATEWAY_INVALID_RESPONSE');
    const body = response.body as JsonRpcResponse;
    if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || body.id !== id) {
      throw new GatewayMcpError('GATEWAY_INVALID_RESPONSE');
    }
    if (body.error) throw new GatewayMcpError('TOOL_EXECUTION_ERROR');
    if (!Object.hasOwn(body, 'result')) throw new GatewayMcpError('GATEWAY_INVALID_RESPONSE');
    return body.result;
  }
}

/** SigV4 is isolated here; tool and agent code never handle credentials or request signing. */
export class SigV4GatewayTransport implements GatewayMcpTransport {
  private readonly endpoint: URL;
  private readonly signer: SignatureV4;

  public constructor(gatewayUrl: string, region: string) {
    this.endpoint = new URL(gatewayUrl);
    this.signer = new SignatureV4({
      credentials: defaultProvider(),
      region,
      service: 'bedrock-agentcore',
      sha256: Sha256
    });
  }

  public async post(
    body: unknown,
    signal?: AbortSignal
  ): Promise<{ status: number; body: unknown }> {
    const payload = JSON.stringify(body);
    const request = await this.signer.sign(
      new HttpRequest({
        protocol: this.endpoint.protocol,
        hostname: this.endpoint.hostname,
        method: 'POST',
        path: `${this.endpoint.pathname.replace(/\/$/, '')}/mcp`,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'mcp-protocol-version': MCP_PROTOCOL_VERSION
        },
        body: payload,
        ...(this.endpoint.port ? { port: Number(this.endpoint.port) } : {})
      })
    );
    const response = await fetch(`${this.endpoint.toString().replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers: request.headers,
      body: payload,
      ...(signal ? { signal } : {})
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GatewayMcpError('GATEWAY_INVALID_RESPONSE');
    }
    return { status: response.status, body: parsed };
  }
}

export class GatewayMcpError extends Error {
  public constructor(
    public readonly code:
      | 'GATEWAY_UNAVAILABLE'
      | 'GATEWAY_UNAUTHORIZED'
      | 'GATEWAY_INVALID_RESPONSE'
      | 'TOOL_EXECUTION_ERROR'
  ) {
    super(code);
  }
}
