'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Section } from '@astryxdesign/core/Section';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PlaygroundInvokeResponse, ToolActivity } from '@agent-launchpad/schemas';
import { ControlApiError, createControlApiClient } from '../../lib/control-api';
import { useActiveTenant } from '../../lib/active-tenant';

const api = () =>
  createControlApiClient({
    baseUrl: `${window.location.origin}/api/control`,
    getAccessToken: () => null
  });

export function activityState(status: ToolActivity['status']) {
  return status === 'SUCCEEDED' ? 'success' : status === 'DENIED' ? 'warning' : 'error';
}

export function AgentPlayground({ agentId }: Readonly<{ agentId: string }>) {
  const [prompt, setPrompt] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [response, setResponse] = useState<PlaygroundInvokeResponse>();
  const { tenant } = useActiveTenant();
  const tenantId = tenant?.tenantId;
  const agent = useQuery({
    queryKey: ['agent', tenantId, agentId],
    queryFn: () => api().agents.get(tenantId!, agentId),
    enabled: Boolean(tenantId),
    retry: (attempt, cause) =>
      !(cause instanceof ControlApiError && [401, 403, 404].includes(cause.status)) && attempt < 3
  });
  const invoke = useMutation({
    mutationFn: () =>
      api().agents.invoke(tenantId!, agentId, { prompt, ...(sessionId ? { sessionId } : {}) }),
    retry: false,
    onSuccess: (value) => {
      setResponse(value);
      setSessionId(value.sessionId);
    }
  });
  if (!agent.data && agent.isLoading)
    return (
      <Banner
        status="info"
        title="Loading playground"
        description="Retrieving the deployed agent."
      />
    );
  if (!agent.data)
    return (
      <Banner
        status="error"
        title="Playground unavailable"
        description="This agent is unavailable or you no longer have access."
      />
    );
  const ready = Boolean(
    agent.data.runtimeArn &&
      agent.data.runtimeVersion &&
      agent.data.runtimeEndpointName === 'production'
  );
  if (!ready)
    return (
      <VStack gap={4}>
        <Banner
          status="warning"
          title="Production Runtime not ready"
          description="Deploy and promote this agent before using the playground."
        />
        <Button href="/dashboard" label="Go to deployments" variant="secondary" />
      </VStack>
    );
  const error =
    invoke.error instanceof ControlApiError
      ? invoke.error.body.message
      : invoke.error
        ? 'The deployed agent is temporarily unavailable.'
        : undefined;
  return (
    <VStack gap={4}>
      <Section>
        <Heading level={1}>{agent.data.name} playground</Heading>
        <MetadataList>
          <MetadataListItem label="Runtime version">{agent.data.runtimeVersion}</MetadataListItem>
          <MetadataListItem label="Endpoint">production</MetadataListItem>
          <MetadataListItem label="Target">
            {agent.data.configuration.deploymentTarget.accountId} · {agent.data.region}
          </MetadataListItem>
        </MetadataList>
      </Section>
      <Banner
        status="warning"
        title="Live demo invocation"
        description="This playground invokes the deployed agent. Enabled tools may modify the demo support data."
      />
      <Section>
        <VStack gap={3}>
          <TextArea
            label="Prompt"
            value={prompt}
            onChange={setPrompt}
            maxLength={8000}
            rows={6}
            isDisabled={invoke.isPending}
          />
          <Button
            label="Send"
            onClick={() => invoke.mutate()}
            isLoading={invoke.isPending}
            isDisabled={invoke.isPending || !prompt.trim()}
          />
          <Button
            label="New session"
            variant="secondary"
            onClick={() => {
              setSessionId(undefined);
              setResponse(undefined);
            }}
            isDisabled={invoke.isPending}
          />
        </VStack>
      </Section>
      {error ? <Banner status="error" title="Invocation failed" description={error} /> : null}
      {response ? (
        <Section>
          <VStack gap={3}>
            <Heading level={2}>Assistant result</Heading>
            <Text as="p">{response.result}</Text>
            <Heading level={2}>Tool activity</Heading>
            {response.toolActivity.length === 0 ? (
              <Text as="p" color="secondary">
                No tools were used for this request.
              </Text>
            ) : (
              <List listStyle="decimal">
                {response.toolActivity.map((activity, index) => (
                  <ListItem key={`${index}-${activity.tool}`}>
                    <StatusDot status={activityState(activity.status)} /> {activity.tool} —{' '}
                    {activity.status}
                    {activity.reasonCode ? ` (${activity.reasonCode})` : ''}
                  </ListItem>
                ))}
              </List>
            )}
          </VStack>
        </Section>
      ) : null}
    </VStack>
  );
}
