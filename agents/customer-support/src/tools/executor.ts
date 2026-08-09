import type { ToolInput, ToolName } from './definitions.js';

export interface ToolExecutionRequest {
  readonly name: ToolName;
  readonly input: ToolInput;
  /** Stable Bedrock tool-use ID, retained for a retried gateway tool call. */
  readonly requestId?: string;
}

export type ToolExecutionResult =
  | { readonly status: 'success'; readonly data: unknown }
  | {
      readonly status: 'error';
      readonly code:
        | 'TOOL_UNAVAILABLE'
        | 'TOOL_EXECUTION_ERROR'
        | 'GATEWAY_UNAVAILABLE'
        | 'GATEWAY_UNAUTHORIZED'
        | 'GATEWAY_TOOL_NOT_AVAILABLE'
        | 'GATEWAY_INVALID_RESPONSE'
        | 'TOOL_TIMEOUT'
        | 'TOOL_VALIDATION_ERROR';
      readonly message: string;
    };

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

/** SAY-102 will replace this with a Gateway-backed executor. It never invents customer data. */
export class UnavailableToolExecutor implements ToolExecutor {
  public async execute(): Promise<ToolExecutionResult> {
    return {
      status: 'error',
      code: 'TOOL_UNAVAILABLE',
      message: 'The requested support service is not available.'
    };
  }
}
