'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Heading } from '@astryxdesign/core/Heading';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Section } from '@astryxdesign/core/Section';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useQuery } from '@tanstack/react-query';
import { createControlApiClient } from '../../lib/control-api';

const api = () =>
  createControlApiClient({
    baseUrl: `${window.location.origin}/api/control`,
    getAccessToken: () => null
  });

export function AgentObservability({ agentId }: Readonly<{ agentId: string }>) {
  const membership = useQuery({ queryKey: ['me'], queryFn: () => api().me.get() });
  const tenantId = membership.data?.tenants[0]?.tenantId;
  const agent = useQuery({
    queryKey: ['agent', tenantId, agentId],
    queryFn: () => api().agents.get(tenantId!, agentId),
    enabled: Boolean(tenantId)
  });
  const metrics = useQuery({
    queryKey: ['metrics', tenantId, agentId],
    queryFn: () => api().agents.metrics(tenantId!, agentId),
    enabled: Boolean(tenantId)
  });
  const executions = useQuery({
    queryKey: ['executions', tenantId, agentId],
    queryFn: () => api().agents.executions(tenantId!, agentId, { pageSize: 20 }),
    enabled: Boolean(tenantId)
  });
  const audits = useQuery({
    queryKey: ['audit-events', tenantId],
    queryFn: () => api().auditEvents.list(tenantId!, { pageSize: 25 }),
    enabled: Boolean(tenantId)
  });
  if (!agent.data && agent.isLoading)
    return (
      <Banner
        status="info"
        title="Loading operations"
        description="Retrieving agent observability."
      />
    );
  if (!agent.data)
    return (
      <Banner
        status="error"
        title="Operations unavailable"
        description="This agent is unavailable or you no longer have access."
      />
    );
  const snapshot = metrics.data;
  const current = snapshot && 'windowStart' in snapshot ? snapshot : undefined;
  const setupRequired = !current && snapshot?.availability === 'UNAVAILABLE';
  const agentAudits = (audits.data?.data ?? []).filter(
    (value) => value.resourceId === agentId || value.metadata?.agentId === agentId
  );
  return (
    <VStack gap={4}>
      <Section>
        <Heading level={1}>{agent.data.name} operations</Heading>
        <MetadataList>
          <MetadataListItem label="Runtime status">{agent.data.status}</MetadataListItem>
          <MetadataListItem label="Production version">
            {agent.data.runtimeVersion ?? 'Not deployed'}
          </MetadataListItem>
          <MetadataListItem label="Endpoint">
            {agent.data.runtimeEndpointName ?? 'Not available'}
          </MetadataListItem>
          <MetadataListItem label="Metrics updated">
            {current?.collectedAt ?? 'Unavailable'}
          </MetadataListItem>
        </MetadataList>
      </Section>
      {setupRequired ? (
        <Banner
          status="warning"
          title="CloudWatch trace search setup required"
          description="A customer account administrator must enable CloudWatch Transaction Search before AgentCore traces can be searched."
        />
      ) : null}
      <Section>
        <Heading level={2}>Last 15m</Heading>
        {current ? (
          <MetadataList>
            <MetadataListItem label="Invocations">
              {String(current.invocationCount)}
            </MetadataListItem>
            <MetadataListItem label="P95 latency">
              {current.latencyP95Ms === undefined
                ? 'Not available'
                : `${Math.round(current.latencyP95Ms)} ms`}
            </MetadataListItem>
            <MetadataListItem label="Errors">{`${current.errorCount}${current.errorRate === undefined ? '' : ` (${Math.round(current.errorRate * 100)}%)`}`}</MetadataListItem>
            <MetadataListItem label="Policy denials">
              {String(current.policyDenyCount ?? 0)}
            </MetadataListItem>
          </MetadataList>
        ) : (
          <Text as="p" color="secondary">
            Metrics are currently unavailable. The latest successful snapshot is retained when
            collection fails.
          </Text>
        )}
      </Section>
      <Section>
        <Heading level={2}>Recent executions</Heading>
        {(executions.data?.data.length ?? 0) === 0 ? (
          <Text as="p" color="secondary">
            No execution summaries are available yet.
          </Text>
        ) : (
          <List>
            {executions.data?.data.map((execution) => (
              <ListItem key={execution.executionId}>
                <StatusDot status={execution.status === 'SUCCEEDED' ? 'success' : 'error'} />{' '}
                {execution.startedAt} · {execution.status} · {execution.durationMs} ms ·{' '}
                {execution.toolActivity.map((tool) => `${tool.tool} (${tool.status})`).join(', ') ||
                  'No tools'}{' '}
                · {execution.runtimeVersion ?? 'No runtime version'}
              </ListItem>
            ))}
          </List>
        )}
      </Section>
      <Section>
        <Heading level={2}>Audit trail</Heading>
        {agentAudits.length === 0 ? (
          <Text as="p" color="secondary">
            No audit events are available for this agent.
          </Text>
        ) : (
          <List>
            {agentAudits.map((event) => (
              <ListItem key={event.id}>
                {event.createdAt} · {event.action} · {event.resourceType}
              </ListItem>
            ))}
          </List>
        )}
      </Section>
    </VStack>
  );
}
