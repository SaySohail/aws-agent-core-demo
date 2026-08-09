import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import type { AgentCoreMetricsReader, MetricValues } from './index.js';

/** Exact dimensions are built from deployed Runtime/Gateway identifiers, never logical tenant input. */
export class CloudWatchAgentCoreMetricsReader implements AgentCoreMetricsReader {
  async read(input: Parameters<AgentCoreMetricsReader['read']>[0]): Promise<MetricValues> {
    if (!input.agent.runtimeId) throw new Error('RUNTIME_NOT_DEPLOYED');
    const dimensions = [{ Name: 'RuntimeId', Value: input.agent.runtimeId }];
    const queries: MetricDataQuery[] = [
      metric('invocations', 'InvocationCount', 'Sum', dimensions),
      metric('errors', 'InvocationErrors', 'Sum', dimensions),
      metric('latencyAverage', 'InvocationLatency', 'Average', dimensions),
      metric('latencyP95', 'InvocationLatency', 'p95', dimensions),
      metric('throttles', 'InvocationThrottles', 'Sum', dimensions),
      metric('sessions', 'ActiveSessionCount', 'Maximum', dimensions)
    ];
    if (input.agent.gatewayArn) {
      const gatewayDimensions = [{ Name: 'GatewayArn', Value: input.agent.gatewayArn }];
      queries.push(
        metric('policyAllows', 'PolicyAllowCount', 'Sum', gatewayDimensions),
        metric('policyDenies', 'PolicyDenyCount', 'Sum', gatewayDimensions)
      );
    }
    const response = await new CloudWatchClient({ region: input.agent.region, credentials: input.credentials }).send(
      new GetMetricDataCommand({
        StartTime: input.start,
        EndTime: input.end,
        ScanBy: 'TimestampDescending',
        MetricDataQueries: queries
      })
    );
    const values = new Map((response.MetricDataResults ?? []).map((result) => [result.Id, result.Values?.[0]]));
    const latencyAverageMs = optional(values.get('latencyAverage'));
    const latencyP95Ms = optional(values.get('latencyP95'));
    const sessionCount = optional(values.get('sessions'));
    const policyAllowCount = optional(values.get('policyAllows'));
    const policyDenyCount = optional(values.get('policyDenies'));
    return {
      invocationCount: number(values.get('invocations')),
      errorCount: number(values.get('errors')),
      throttleCount: number(values.get('throttles')),
      ...(latencyAverageMs === undefined ? {} : { latencyAverageMs }),
      ...(latencyP95Ms === undefined ? {} : { latencyP95Ms }),
      ...(sessionCount === undefined ? {} : { sessionCount }),
      ...(policyAllowCount === undefined ? {} : { policyAllowCount }),
      ...(policyDenyCount === undefined ? {} : { policyDenyCount })
    };
  }
}

function metric(id: string, name: string, stat: string, dimensions: { Name: string; Value: string }[]): MetricDataQuery {
  return { Id: id, ReturnData: true, MetricStat: { Metric: { Namespace: 'AWS/BedrockAgentCore', MetricName: name, Dimensions: dimensions }, Period: 900, Stat: stat } };
}
function number(value: number | undefined): number { return value ?? 0; }
function optional(value: number | undefined): number | undefined { return value; }
