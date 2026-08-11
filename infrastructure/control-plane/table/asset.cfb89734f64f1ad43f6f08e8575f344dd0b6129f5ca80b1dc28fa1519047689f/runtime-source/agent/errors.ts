export type AgentErrorCode =
  | 'MODEL_TIMEOUT'
  | 'MODEL_THROTTLED'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_MODEL_RESPONSE'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_VALIDATION_ERROR'
  | 'TOOL_EXECUTION_ERROR'
  | 'TOOL_ITERATION_LIMIT'
  | 'UNKNOWN_TOOL';

const messages: Record<AgentErrorCode, string> = {
  MODEL_TIMEOUT: 'The support assistant timed out. Please try again.',
  MODEL_THROTTLED: 'The support assistant is busy. Please try again shortly.',
  MODEL_UNAVAILABLE: 'The support assistant is temporarily unavailable. Please try again.',
  INVALID_MODEL_RESPONSE: 'The support assistant returned an invalid response.',
  TOOL_UNAVAILABLE: 'A required support service is not available yet.',
  TOOL_VALIDATION_ERROR: 'The support assistant requested invalid support data.',
  TOOL_EXECUTION_ERROR: 'A support service could not complete the request.',
  TOOL_ITERATION_LIMIT: 'The support request exceeded its safe processing limit.',
  UNKNOWN_TOOL: 'The support assistant requested an unsupported service.'
};

export class CustomerSupportAgentError extends Error {
  public readonly message: string;

  public constructor(public readonly code: AgentErrorCode) {
    super(messages[code]);
    this.message = messages[code];
  }
}

export function isCustomerSupportAgentError(error: unknown): error is CustomerSupportAgentError {
  return error instanceof CustomerSupportAgentError;
}
