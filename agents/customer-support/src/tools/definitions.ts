import type { ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import {
  customerSupportGatewayToolDefinitions,
  createSupportTicketInputSchema,
  getOrderInputSchema,
  searchOrdersInputSchema
} from '@agent-launchpad/schemas';
import { z } from 'zod';

export { createSupportTicketInputSchema, getOrderInputSchema, searchOrdersInputSchema };

export const toolInputSchemas = {
  get_order: getOrderInputSchema,
  search_orders: searchOrdersInputSchema,
  create_support_ticket: createSupportTicketInputSchema
} as const;

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInput = z.infer<(typeof toolInputSchemas)[ToolName]>;

const toolDefinitions: NonNullable<ToolConfiguration['tools']> =
  customerSupportGatewayToolDefinitions.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema }
    }
  })) as unknown as NonNullable<ToolConfiguration['tools']>;

export const customerSupportToolConfiguration: ToolConfiguration = { tools: toolDefinitions };

/** The same logical contracts are rendered for Bedrock and the Gateway target schemas. */
export interface GatewayToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

export const gatewayToolDefinitions: readonly GatewayToolDefinition[] = toolDefinitions.map(
  (tool) => {
    const spec = tool.toolSpec;
    if (!spec?.name || !spec.description || !spec.inputSchema?.json) {
      throw new Error('Customer-support tool definition is incomplete.');
    }
    return {
      name: spec.name as ToolName,
      description: spec.description,
      inputSchema: spec.inputSchema.json as Record<string, unknown>
    };
  }
);

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(toolInputSchemas, value);
}

export function validateToolInput(name: ToolName, input: unknown): ToolInput | undefined {
  const result = toolInputSchemas[name].safeParse(input);
  return result.success ? result.data : undefined;
}
