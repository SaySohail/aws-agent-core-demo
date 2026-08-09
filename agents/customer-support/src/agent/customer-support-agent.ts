import type {
  ContentBlock,
  ConverseCommandInput,
  Message,
  ToolUseBlock
} from '@aws-sdk/client-bedrock-runtime';
import type { CustomerSupportAgentConfig } from './config.js';
import { CustomerSupportAgentError } from './errors.js';
import type { ModelClient } from './bedrock-model.js';
import { customerSupportSystemPrompt } from './system-prompt.js';
import {
  customerSupportToolConfiguration,
  isToolName,
  validateToolInput
} from '../tools/definitions.js';
import type { ToolExecutionResult, ToolExecutor } from '../tools/executor.js';
import type { RuntimeResponse, ToolActivity } from '@agent-launchpad/schemas';

export interface AgentLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

const consoleLogger: AgentLogger = {
  info: (event) => console.log(JSON.stringify(event)),
  error: (event) => console.error(JSON.stringify(event))
};

export class CustomerSupportAgent {
  public constructor(
    private readonly config: CustomerSupportAgentConfig,
    private readonly model: ModelClient,
    private readonly tools: ToolExecutor,
    private readonly logger: AgentLogger = consoleLogger
  ) {}

  public async invoke(prompt: string): Promise<string> {
    return (await this.invokeWithActivity(prompt)).result;
  }

  /** Runtime-facing operation retains safe ordered tool activity without changing agent callers. */
  public async invokeWithActivity(prompt: string): Promise<RuntimeResponse> {
    const startedAt = Date.now();
    const messages: Message[] = [{ role: 'user', content: [{ text: prompt }] }];
    const toolActivity: ToolActivity[] = [];
    this.logger.info({ event: 'invocation_started' });

    for (let iteration = 0; ; iteration += 1) {
      const response = await this.converse(messages);
      const assistantMessage = response.output?.message;
      if (assistantMessage?.role !== 'assistant' || !assistantMessage.content?.length) {
        throw new CustomerSupportAgentError('INVALID_MODEL_RESPONSE');
      }
      messages.push(assistantMessage);

      const toolUses = assistantMessage.content.flatMap((block) =>
        block.toolUse ? [block.toolUse] : []
      );
      if (toolUses.length === 0) {
        const text = assistantMessage.content
          .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
          .join('\n')
          .trim();
        if (!text) throw new CustomerSupportAgentError('INVALID_MODEL_RESPONSE');
        this.logger.info({
          event: 'invocation_completed',
          iteration,
          elapsedMs: Date.now() - startedAt
        });
        return { result: text, toolActivity };
      }

      if (iteration >= this.config.maxToolIterations) {
        throw new CustomerSupportAgentError('TOOL_ITERATION_LIMIT');
      }

      const results: ContentBlock[] = [];
      for (const toolUse of toolUses) {
        results.push(await this.executeToolUse(toolUse, toolActivity));
      }
      messages.push({ role: 'user', content: results });
    }
  }

  private async converse(messages: Message[]) {
    const input: ConverseCommandInput = {
      modelId: this.config.modelId,
      system: [{ text: customerSupportSystemPrompt(this.config.companyName) }],
      messages,
      toolConfig: customerSupportToolConfiguration,
      inferenceConfig: {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature
      }
    };
    try {
      const response = await this.model.converse(
        input,
        AbortSignal.timeout(this.config.modelTimeoutMs)
      );
      this.logger.info({ event: 'model_call_completed', messageCount: messages.length });
      return response;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      this.logger.error({ event: 'model_call_failed', errorName: name || 'UnknownError' });
      if (name === 'AbortError' || name === 'TimeoutError')
        throw new CustomerSupportAgentError('MODEL_TIMEOUT');
      if (name === 'ThrottlingException' || name === 'TooManyRequestsException') {
        throw new CustomerSupportAgentError('MODEL_THROTTLED');
      }
      throw new CustomerSupportAgentError('MODEL_UNAVAILABLE');
    }
  }

  private async executeToolUse(
    toolUse: ToolUseBlock,
    toolActivity: ToolActivity[]
  ): Promise<ContentBlock> {
    if (!toolUse.toolUseId || !toolUse.name)
      throw new CustomerSupportAgentError('INVALID_MODEL_RESPONSE');
    if (!isToolName(toolUse.name)) throw new CustomerSupportAgentError('UNKNOWN_TOOL');
    const input = validateToolInput(toolUse.name, toolUse.input);
    if (!input) throw new CustomerSupportAgentError('TOOL_VALIDATION_ERROR');

    this.logger.info({ event: 'tool_requested', toolName: toolUse.name });
    let execution: ToolExecutionResult;
    try {
      execution = await this.tools.execute({
        name: toolUse.name,
        input,
        requestId: toolUse.toolUseId
      });
    } catch {
      execution = {
        status: 'error',
        code: 'TOOL_EXECUTION_ERROR',
        message: 'The support service failed.'
      };
    }
    this.logger.info({ event: 'tool_completed', toolName: toolUse.name, status: execution.status });
    toolActivity.push({
      tool: toolUse.name,
      status:
        execution.status === 'success'
          ? 'SUCCEEDED'
          : execution.code === 'POLICY_DENIED'
            ? 'DENIED'
            : 'FAILED',
      ...(execution.status === 'error' && execution.code === 'POLICY_DENIED'
        ? { reasonCode: 'POLICY_DENIED' as const }
        : {})
    });

    // Tool data remains a structured user/tool-result message; it is never added to the system prompt.
    const payload =
      execution.status === 'success'
        ? { status: 'success', data: execution.data }
        : { status: 'error', code: execution.code, message: execution.message };
    return {
      toolResult: {
        toolUseId: toolUse.toolUseId,
        content: [{ text: this.serializeToolResult(payload) }],
        status: execution.status
      }
    };
  }

  private serializeToolResult(payload: unknown): string {
    try {
      return JSON.stringify(payload);
    } catch {
      return JSON.stringify({
        status: 'error',
        code: 'TOOL_EXECUTION_ERROR',
        message: 'Invalid tool result.'
      });
    }
  }
}
