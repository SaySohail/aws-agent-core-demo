import { z } from 'zod';

export const agentLaunchRequestSchema = z.object({
  agentId: z.string().min(1),
  customerId: z.string().min(1),
  environment: z.enum(['development', 'staging', 'production'])
});

export type AgentLaunchRequest = z.infer<typeof agentLaunchRequestSchema>;
