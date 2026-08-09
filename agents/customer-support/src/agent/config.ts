import { z } from 'zod';

const environmentSchema = z.object({
  AWS_REGION: z
    .string({ required_error: 'AWS_REGION is required.' })
    .trim()
    .min(1, 'AWS_REGION is required.'),
  BEDROCK_MODEL_ID: z
    .string({ required_error: 'BEDROCK_MODEL_ID is required.' })
    .trim()
    .min(1, 'BEDROCK_MODEL_ID is required.'),
  AGENT_COMPANY_NAME: z.string().trim().min(1).max(200).default('the company'),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1).max(8192).default(512),
  AGENT_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  AGENT_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(10).default(5),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  AGENT_GATEWAY_URL: z.string().url('AGENT_GATEWAY_URL must be a valid URL.'),
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000)
});

export interface CustomerSupportAgentConfig {
  readonly region: string;
  readonly modelId: string;
  readonly companyName: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly maxToolIterations: number;
  readonly modelTimeoutMs: number;
  readonly gatewayUrl: string;
  readonly toolTimeoutMs: number;
}

export function loadCustomerSupportAgentConfig(
  environment: NodeJS.ProcessEnv = process.env
): CustomerSupportAgentConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(
      `Customer-support agent configuration is invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join(' ')}`
    );
  }

  const value = parsed.data;
  return {
    region: value.AWS_REGION,
    modelId: value.BEDROCK_MODEL_ID,
    companyName: value.AGENT_COMPANY_NAME,
    maxTokens: value.AGENT_MAX_TOKENS,
    temperature: value.AGENT_TEMPERATURE,
    maxToolIterations: value.AGENT_MAX_TOOL_ITERATIONS,
    modelTimeoutMs: value.AGENT_MODEL_TIMEOUT_MS,
    gatewayUrl: value.AGENT_GATEWAY_URL,
    toolTimeoutMs: value.AGENT_TOOL_TIMEOUT_MS
  };
}
