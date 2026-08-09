'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Section } from '@astryxdesign/core/Section';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  DeploymentDetail as DeploymentDetailData,
  DeploymentStatus
} from '@agent-launchpad/schemas';
import { createControlApiClient, ControlApiError } from '../../lib/control-api';
import { deploymentError } from './deployment-errors';
import {
  deploymentStages,
  deploymentStatusLabel,
  isTerminal,
  presentedStageState,
  stageLabel
} from './deployment-presentation';
import { VersionHistory } from './version-history';
import { useActiveTenant } from '../../lib/active-tenant';

const api = () =>
  createControlApiClient({
    baseUrl: `${window.location.origin}/api/control`,
    getAccessToken: () => null
  });

const dot = (state: 'pending' | 'active' | 'succeeded' | 'failed') =>
  state === 'succeeded'
    ? 'success'
    : state === 'failed'
      ? 'error'
      : state === 'active'
        ? 'accent'
        : 'neutral';

function timestamp(value: string | undefined) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
        new Date(value)
      )
    : '—';
}

function statusColor(status: DeploymentStatus) {
  return status === 'READY'
    ? 'success'
    : status === 'FAILED'
      ? 'error'
      : status === 'QUEUED'
        ? 'warning'
        : 'accent';
}

export function deploymentPollingInterval(status: DeploymentStatus) {
  return isTerminal(status) ? false : 2500;
}

export function sortedEvents(events: readonly DeploymentDetailData['events'][number][]) {
  return [...new Map(events.map((event) => [event.id, event])).values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

export function DeploymentDetail({ deploymentId }: Readonly<{ deploymentId: string }>) {
  const { tenant } = useActiveTenant();
  const tenantId = tenant?.tenantId;
  const query = useQuery({
    queryKey: ['deployment', tenantId, deploymentId],
    queryFn: () => api().deployments.get(tenantId!, deploymentId),
    enabled: Boolean(tenantId),
    refetchInterval: (queryState) =>
      deploymentPollingInterval(queryState.state.data?.deployment.status ?? 'QUEUED'),
    refetchOnWindowFocus: true,
    retry: (attempt, cause) =>
      !(cause instanceof ControlApiError && [401, 403, 404].includes(cause.status)) && attempt < 3
  });
  const retry = useMutation({
    mutationFn: () =>
      api().deployments.retry(
        tenantId!,
        deploymentId,
        `retry-${deploymentId}-${crypto.randomUUID()}`
      ),
    onSuccess: ({ deploymentId: nextDeploymentId }) =>
      window.location.assign(
        `/agents/${query.data?.deployment.agentId}/deployments/${nextDeploymentId}`
      )
  });

  if (!query.data && query.isLoading)
    return (
      <Banner
        status="info"
        title="Loading deployment"
        description="Retrieving the latest deployment state."
      />
    );
  if (!query.data) {
    const accessLost =
      query.error instanceof ControlApiError && [401, 403, 404].includes(query.error.status);
    return (
      <Banner
        status="error"
        title={accessLost ? 'Deployment unavailable' : 'Unable to load deployment'}
        description={
          accessLost
            ? 'This deployment is unavailable or you no longer have access.'
            : 'Please try again shortly.'
        }
      />
    );
  }
  if (query.error instanceof ControlApiError && [401, 403, 404].includes(query.error.status)) {
    return (
      <Banner
        status="error"
        title="Deployment unavailable"
        description="This deployment is unavailable or you no longer have access."
      />
    );
  }

  const detail = query.data;
  const deployment = detail.deployment;
  const events = sortedEvents(detail.events);
  const completedStages = new Set(
    events.filter((event) => event.status !== 'FAILED').map((event) => event.toStage)
  );
  const failed = deployment.status === 'FAILED';
  const error = deploymentError(deployment.errorCode);
  const candidate = detail.candidateRuntimeVersion;
  const history = useQuery({
    queryKey: ['deployment-history', tenantId, deployment.agentId],
    queryFn: () => api().deployments.listForAgent(tenantId!, deployment.agentId, { pageSize: 10 }),
    enabled: Boolean(tenantId)
  });

  return (
    <VStack gap={4} aria-live="polite">
      {query.isRefetchError ? (
        <Banner
          status="warning"
          title="Connection issue"
          description="Showing the last successfully loaded deployment state. Refreshing again automatically."
        />
      ) : null}
      <Section padding={4} dividers={['bottom']}>
        <VStack gap={2}>
          <Heading level={1}>{detail.agentName} deployment</Heading>
          <HStack gap={2} align="center">
            <StatusDot
              variant={statusColor(deployment.status)}
              label={deploymentStatusLabel(deployment.status)}
              isPulsing={!isTerminal(deployment.status)}
            />
            <Text as="p">{deploymentStatusLabel(deployment.status)}</Text>
            <Token label={deployment.id} size="sm" color="gray" />
          </HStack>
          <Text as="p" color="secondary">
            Target account {deployment.snapshot.accountId} · {deployment.snapshot.region}
          </Text>
        </VStack>
      </Section>

      {deployment.status === 'READY' ? (
        <Banner
          status="success"
          title="Deployment ready"
          description={`Completed ${timestamp(deployment.completedAt)}. The production endpoint is serving the promoted Runtime version.`}
        />
      ) : null}
      {failed ? (
        <Banner
          status="error"
          title={error.title}
          description={`${error.description} ${error.action}`}
        />
      ) : null}
      {failed && detail.currentConfigurationRevision !== deployment.configurationRevision ? (
        <Banner
          status="warning"
          title="Configuration has changed"
          description={`This deployment uses configuration revision ${deployment.configurationRevision}. Retrying will retry revision ${deployment.configurationRevision}; the current agent is revision ${detail.currentConfigurationRevision}.`}
        />
      ) : null}

      <Grid columns={{ minWidth: 320, max: 2 }} gap={4}>
        <Section padding={4} dividers={['bottom']}>
          <VStack gap={3}>
            <Heading level={2}>Deployment progress</Heading>
            {deploymentStages.map((presented) => {
              const state = presentedStageState(
                presented,
                deployment.stage,
                deployment.status,
                completedStages
              );
              return (
                <HStack key={presented.id} gap={2} align="center">
                  <StatusDot
                    variant={dot(state)}
                    label={`${presented.label}: ${state}`}
                    isPulsing={state === 'active'}
                  />
                  <Text as="p">
                    {presented.label} — {state}
                  </Text>
                </HStack>
              );
            })}
          </VStack>
        </Section>
        <Section padding={4} dividers={['bottom']}>
          <VStack gap={3}>
            <Heading level={2}>Deployment metadata</Heading>
            <MetadataList columns="single">
              <MetadataListItem label="Configuration revision">
                {String(deployment.configurationRevision)}
              </MetadataListItem>
              <MetadataListItem label="Template">{`${deployment.snapshot.templateId} v${deployment.snapshot.templateVersion}`}</MetadataListItem>
              <MetadataListItem label="Artifact">
                {deployment.snapshot.artifactSha256 ??
                  deployment.snapshot.artifactId ??
                  'Not available'}
              </MetadataListItem>
              <MetadataListItem label="Requested">
                {timestamp(deployment.createdAt)}
              </MetadataListItem>
              <MetadataListItem label="Started">{timestamp(deployment.startedAt)}</MetadataListItem>
              <MetadataListItem label="Completed">
                {timestamp(deployment.completedAt)}
              </MetadataListItem>
            </MetadataList>
          </VStack>
        </Section>
      </Grid>

      <Section padding={4} dividers={['bottom']}>
        <VStack gap={3}>
          <Heading level={2}>Deployment timeline</Heading>
          {events.length ? (
            events.map((event) => <TimelineRow key={event.id} event={event} />)
          ) : (
            <Text as="p" color="secondary">
              No deployment events have been recorded yet.
            </Text>
          )}
        </VStack>
      </Section>

      <Section padding={4} dividers={['bottom']}>
        <VStack gap={3}>
          <Heading level={2}>Deployment history</Heading>
          {history.data?.data.length ? (
            history.data.data.map((item) => (
              <HStack key={item.id} gap={2} align="center">
                <StatusDot
                  variant={statusColor(item.status)}
                  label={deploymentStatusLabel(item.status)}
                />
                <VStack gap={0.5}>
                  <Button
                    href={`/agents/${item.agentId}/deployments/${item.id}`}
                    label={`${deploymentStatusLabel(item.status)} · revision ${item.configurationRevision}`}
                    variant="ghost"
                  />
                  <Text as="p" color="secondary">
                    {item.id} · {timestamp(item.completedAt ?? item.createdAt)}
                  </Text>
                </VStack>
              </HStack>
            ))
          ) : (
            <Text as="p" color="secondary">
              No other deployments recorded for this agent.
            </Text>
          )}
        </VStack>
      </Section>

      <VersionHistory agentId={deployment.agentId} />

      {deployment.status === 'READY' || candidate || detail.production.endpointName ? (
        <Section padding={4} dividers={['bottom']}>
          <VStack gap={3}>
            <Heading level={2}>Runtime and production endpoint</Heading>
            <MetadataList columns="single">
              <MetadataListItem label="Candidate Runtime ARN">
                {candidate?.runtimeArn ?? deployment.runtimeId ?? 'Not created'}
              </MetadataListItem>
              <MetadataListItem label="Candidate Runtime version">
                {candidate?.runtimeVersion ?? deployment.runtimeVersion ?? 'Not created'}
              </MetadataListItem>
              <MetadataListItem label="Production endpoint">
                {detail.production.endpointName ?? 'Not promoted'}
              </MetadataListItem>
              <MetadataListItem label="Production endpoint ARN">
                {detail.production.endpointArn ?? 'Not promoted'}
              </MetadataListItem>
              <MetadataListItem label="Current production live version">
                {detail.production.liveVersion ?? 'Not promoted'}
              </MetadataListItem>
            </MetadataList>
          </VStack>
        </Section>
      ) : null}

      {failed ? (
        <HStack gap={2} align="center">
          {detail.retryable ? (
            <Button
              label="Retry deployment"
              onClick={() => retry.mutate()}
              isLoading={retry.isPending}
              isDisabled={retry.isPending}
            />
          ) : null}
          <Button href="/dashboard" label="Review agent configuration" variant="secondary" />
          {retry.isError ? (
            <Text as="p" color="secondary">
              {retry.error instanceof ControlApiError &&
              retry.error.body.code === 'DEPLOYMENT_ALREADY_IN_PROGRESS'
                ? 'Another deployment is already active for this agent.'
                : 'Retry could not be started. Please refresh and try again.'}
            </Text>
          ) : null}
        </HStack>
      ) : null}
    </VStack>
  );
}

function TimelineRow({ event }: Readonly<{ event: DeploymentDetailData['events'][number] }>) {
  const state =
    event.status === 'FAILED' ? 'failed' : event.status === 'READY' ? 'succeeded' : 'active';
  return (
    <HStack gap={2} align="start">
      <StatusDot variant={dot(state)} label={`${stageLabel(event.toStage)}: ${state}`} />
      <VStack gap={0.5}>
        <Text as="p">
          {stageLabel(event.toStage)} — {event.status === 'FAILED' ? 'failed' : 'completed'}
        </Text>
        <Text as="p" color="secondary">
          {timestamp(event.createdAt)}
          {event.errorCode ? ` · ${event.errorCode}` : ''}
        </Text>
      </VStack>
    </HStack>
  );
}
