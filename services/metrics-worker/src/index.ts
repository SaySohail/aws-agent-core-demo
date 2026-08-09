import type {
  AssumedCustomerRoleCredentials,
  ControlPlaneRepository,
  CustomerRoleAssumer
} from '@agent-launchpad/aws';
import type { Agent, AgentMetricsSnapshot } from '@agent-launchpad/schemas';

export interface MetricValues {
  readonly invocationCount: number;
  readonly errorCount: number;
  readonly latencyAverageMs?: number;
  readonly latencyP95Ms?: number;
  readonly throttleCount: number;
  readonly sessionCount?: number;
  readonly policyAllowCount?: number;
  readonly policyDenyCount?: number;
}

/** CloudWatch is behind a narrow port so collection failures stay isolated and testable. */
export interface AgentCoreMetricsReader {
  read(input: {
    agent: Agent;
    credentials: AssumedCustomerRoleCredentials;
    start: Date;
    end: Date;
  }): Promise<MetricValues>;
}

export interface MetricsWorkerDependencies {
  readonly repository: ControlPlaneRepository;
  readonly assumer: CustomerRoleAssumer;
  readonly reader: AgentCoreMetricsReader;
  readonly now?: () => Date;
  readonly report?: (event: string, fields: Record<string, string>) => void;
}

/** Scheduled pull worker. It never runs in an invocation/browser request path. */
export class MetricsWorker {
  public constructor(private readonly dependencies: MetricsWorkerDependencies) {}

  async collectAll(): Promise<{ collected: number; failed: number }> {
    let nextToken: string | undefined;
    let collected = 0;
    let failed = 0;
    do {
      const page = await this.dependencies.repository.listActiveDeployedAgents({
        limit: 100,
        ...(nextToken ? { nextToken } : {})
      });
      for (const agent of page.items) {
        try {
          await this.collectAgent(agent);
          collected += 1;
        } catch (error) {
          failed += 1;
          this.dependencies.report?.('metrics_collection_failed', {
            tenantId: agent.tenantId,
            agentId: agent.id,
            code: safeErrorCode(error)
          });
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return { collected, failed };
  }

  async collectAgent(agent: Agent): Promise<AgentMetricsSnapshot> {
    const connection = await this.dependencies.repository.getAwsConnection(
      agent.tenantId,
      agent.configuration.deploymentTarget.awsConnectionId
    );
    if (!connection || connection.status !== 'VERIFIED') throw new Error('CUSTOMER_ACCESS_REVOKED');
    const end = this.dependencies.now?.() ?? new Date();
    const start = new Date(end.getTime() - 15 * 60 * 1000);
    const credentials = await this.dependencies.assumer.assumeCustomerRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      sessionName: `metrics-${agent.id}`
    });
    const metrics = await this.dependencies.reader.read({ agent, credentials, start, end });
    const snapshot: AgentMetricsSnapshot = {
      tenantId: agent.tenantId,
      agentId: agent.id,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      invocationCount: metrics.invocationCount,
      errorCount: metrics.errorCount,
      ...(metrics.invocationCount
        ? { errorRate: metrics.errorCount / metrics.invocationCount }
        : {}),
      ...(metrics.latencyAverageMs === undefined
        ? {}
        : { latencyAverageMs: metrics.latencyAverageMs }),
      ...(metrics.latencyP95Ms === undefined ? {} : { latencyP95Ms: metrics.latencyP95Ms }),
      throttleCount: metrics.throttleCount,
      ...(metrics.sessionCount === undefined ? {} : { sessionCount: metrics.sessionCount }),
      ...(metrics.policyAllowCount === undefined
        ? {}
        : { policyAllowCount: metrics.policyAllowCount }),
      ...(metrics.policyDenyCount === undefined
        ? {}
        : { policyDenyCount: metrics.policyDenyCount }),
      availability: 'AVAILABLE',
      collectedAt: end.toISOString()
    };
    // A failed read never writes zeroes or replaces the prior successful snapshot.
    await this.dependencies.repository.putAgentMetricsSnapshot(snapshot);
    return snapshot;
  }
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : 'METRICS_COLLECTION_FAILED';
}
