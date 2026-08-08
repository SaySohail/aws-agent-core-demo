import { z } from 'zod';

export const runtimeEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTROL_API_PORT: z.coerce.number().int().positive().default(4000),
  AWS_REGION: z.string().min(1).default('us-east-1')
});

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

/** Parse only the variables a process explicitly passes to it. */
export function validateEnvironment(
  environment: Record<string, string | undefined>
): RuntimeEnvironment {
  return runtimeEnvironmentSchema.parse(environment);
}
