'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Section } from '@astryxdesign/core/Section';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Table, proportional } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentVersionHistoryItem } from '../../lib/control-api';
import { ControlApiError, createControlApiClient } from '../../lib/control-api';
import { useState } from 'react';
import { useActiveTenant } from '../../lib/active-tenant';

const api = () =>
  createControlApiClient({
    baseUrl: `${window.location.origin}/api/control`,
    getAccessToken: () => null
  });

type VersionRow = AgentVersionHistoryItem & Record<string, unknown>;

function timestamp(value: string | undefined) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value)
      )
    : '—';
}

function statusVariant(status: AgentVersionHistoryItem['status']) {
  return status === 'READY' ? 'success' : status === 'FAILED' ? 'error' : 'warning';
}

function productionState(version: AgentVersionHistoryItem): string {
  if (version.currentProduction) return 'Current production';
  if (version.previouslyProduction) return 'Previous known-good';
  if (version.status === 'FAILED') return 'Failed candidate';
  return 'Never promoted';
}

export function VersionHistory({ agentId }: Readonly<{ agentId: string }>) {
  const { tenant } = useActiveTenant();
  const tenantId = tenant?.tenantId;
  const canRollback = ['OWNER', 'ADMIN'].includes(tenant?.role ?? 'MEMBER');
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<AgentVersionHistoryItem>();
  const versions = useQuery({
    queryKey: ['versions', tenantId, agentId],
    queryFn: () => api().agents.versions(tenantId!, agentId, { pageSize: 25 }),
    enabled: Boolean(tenantId),
    retry: (attempt, cause) =>
      !(cause instanceof ControlApiError && [401, 403, 404].includes(cause.status)) && attempt < 3
  });
  const rollback = useMutation({
    mutationFn: (version: AgentVersionHistoryItem) =>
      api().agents.rollback(
        tenantId!,
        agentId,
        version.runtimeVersion,
        `rollback-${agentId}-${version.runtimeVersion}-${crypto.randomUUID()}`
      ),
    onSuccess: ({ deploymentId }) => {
      void queryClient.invalidateQueries({ queryKey: ['versions', tenantId, agentId] });
      window.location.assign(`/agents/${agentId}/deployments/${deploymentId}`);
    }
  });

  const rows = (versions.data?.data ?? []).map((version): VersionRow => ({ ...version }));
  const current = rows.find((version) => version.currentProduction);
  const selectedTarget = selected;
  const columns = [
    {
      key: 'runtimeVersion',
      header: 'Version',
      width: proportional(1),
      renderCell: (version: VersionRow) => <Text as="p">v{version.runtimeVersion}</Text>
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(1),
      renderCell: (version: VersionRow) => (
        <HStack gap={1} align="center">
          <StatusDot variant={statusVariant(version.status)} label={version.status} />
          <Text as="p">{version.status}</Text>
        </HStack>
      )
    },
    {
      key: 'production',
      header: 'Production state',
      width: proportional(2),
      renderCell: (version: VersionRow) => <Text as="p">{productionState(version)}</Text>
    },
    {
      key: 'configurationRevision',
      header: 'Configuration',
      width: proportional(1),
      renderCell: (version: VersionRow) => (
        <Text as="p">Revision {version.configurationRevision}</Text>
      )
    },
    {
      key: 'artifact',
      header: 'Artifact',
      width: proportional(2),
      renderCell: (version: VersionRow) => (
        <Token label={version.artifactSha256} size="sm" color="gray" />
      )
    },
    {
      key: 'deployedAt',
      header: 'Promoted',
      width: proportional(2),
      renderCell: (version: VersionRow) => (
        <Text as="p">{timestamp(version.deployedAt ?? version.createdAt)}</Text>
      )
    },
    {
      key: 'action',
      header: 'Action',
      width: proportional(1),
      renderCell: (version: VersionRow) =>
        version.rollbackEligible && canRollback ? (
          <Button
            label={`Roll back to v${version.runtimeVersion}`}
            variant="secondary"
            onClick={() => setSelected(version)}
          />
        ) : (
          <Text as="p" color="secondary">
            {version.rollbackUnavailableReason ??
              (canRollback ? 'Not eligible' : 'Admin or owner required')}
          </Text>
        )
    }
  ];

  return (
    <Section padding={4} dividers={['bottom']}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Version history</Heading>
          <Text as="p" color="secondary">
            Immutable Runtime versions. Production can be repointed only to a known-good version.
          </Text>
        </VStack>
        {versions.isLoading ? (
          <Text as="p" color="secondary">
            Loading version history.
          </Text>
        ) : null}
        {versions.isError ? (
          <Banner
            status="error"
            title="Version history unavailable"
            description="Please refresh and try again shortly."
          />
        ) : null}
        {!versions.isLoading && !versions.isError && rows.length === 0 ? (
          <Text as="p" color="secondary">
            No Runtime versions have been recorded for this agent.
          </Text>
        ) : null}
        {rows.length ? (
          <Table
            data={rows}
            columns={columns}
            idKey="runtimeVersion"
            density="compact"
            dividers="rows"
            hasHover
          />
        ) : null}
        {rollback.isError ? (
          <Banner
            status="error"
            title="Rollback could not be started"
            description={
              rollback.error instanceof ControlApiError
                ? rollback.error.body.message
                : 'Please refresh the version history and try again.'
            }
          />
        ) : null}
      </VStack>
      {selectedTarget ? (
        <AlertDialog
          isOpen
          onOpenChange={(isOpen: boolean) => {
            if (!isOpen && !rollback.isPending) setSelected(undefined);
          }}
          title={`Roll back production to v${selectedTarget.runtimeVersion}?`}
          description={`Production is currently serving ${current ? `v${current.runtimeVersion}` : 'the recorded live version'}. This switches only the production endpoint to v${selectedTarget.runtimeVersion}, using configuration revision ${selectedTarget.configurationRevision} and artifact ${selectedTarget.artifactSha256}. DEFAULT is not changed.`}
          actionLabel={`Roll back to v${selectedTarget.runtimeVersion}`}
          onAction={() => rollback.mutate(selectedTarget)}
          isActionLoading={rollback.isPending}
        />
      ) : null}
    </Section>
  );
}
