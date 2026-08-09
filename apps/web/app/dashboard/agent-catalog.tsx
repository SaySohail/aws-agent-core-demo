'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useEffect, useMemo, useState } from 'react';
import {
  bedrockModelCatalog,
  type Agent,
  type AgentCapability,
  type AgentTemplate
} from '@agent-launchpad/schemas';
import type { AwsConnectionOnboarding } from '../../lib/control-api';
import { useActiveTenant } from '../../lib/active-tenant';

const labels: Record<AgentCapability, string> = {
  ORDER_LOOKUP: 'Order lookup',
  ORDER_SEARCH: 'Search orders',
  CREATE_SUPPORT_TICKET: 'Create support tickets',
  PROCESS_REFUND: 'Process refunds'
};

export function AgentTemplateCatalog() {
  const { tenant } = useActiveTenant();
  const tenantId = tenant?.tenantId;
  const [templates, setTemplates] = useState<readonly AgentTemplate[]>();
  const [connections, setConnections] = useState<readonly AwsConnectionOnboarding[]>();
  const [selected, setSelected] = useState<AgentTemplate>();
  const [name, setName] = useState('Customer Support Agent');
  const [modelId, setModelId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [refundLimit, setRefundLimit] = useState(10000);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<Agent>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    void load();
  }, [tenantId]);
  const target = useMemo(
    () => connections?.find((value) => value.id === connectionId),
    [connections, connectionId]
  );
  const refundsEnabled = capabilities.includes('PROCESS_REFUND');
  const supportedModelIds = (selected?.supportedModelIds ?? []).filter((candidate) =>
    bedrockModelCatalog.some(
      (model) =>
        model.modelId === candidate &&
        target?.region &&
        model.supportedRegions.includes(target.region)
    )
  );

  useEffect(() => {
    if (supportedModelIds.length && !supportedModelIds.includes(modelId))
      setModelId(supportedModelIds[0]!);
  }, [modelId, supportedModelIds]);

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      if (!tenantId) throw new Error('No active tenant membership is available.');
      const [catalogue, awsConnections] = await Promise.all([
        call<AgentTemplate[]>('agent-templates'),
        call<AwsConnectionOnboarding[]>(`tenants/${tenantId}/aws-connections`)
      ]);
      const template = catalogue.find(
        (item) => item.templateId === 'customer-support' && item.status === 'ACTIVE'
      );
      setTemplates(catalogue);
      setConnections(awsConnections);
      setSelected(template);
      if (template) {
        setModelId(template.supportedModelIds[0] ?? '');
        setCapabilities([...template.supportedCapabilities]);
        setRefundLimit(template.guardrails.refunds.defaultAutoApprovalLimitCents);
      }
      setConnectionId(awsConnections.find((item) => item.status === 'VERIFIED')?.id ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load agent templates.');
    } finally {
      setLoading(false);
    }
  }
  function chooseTemplate(id: string) {
    const template = templates?.find((item) => item.templateId === id);
    setSelected(template);
    setSaved(undefined);
    if (template) {
      setModelId(template.supportedModelIds[0] ?? '');
      setCapabilities([...template.supportedCapabilities]);
      setRefundLimit(template.guardrails.refunds.defaultAutoApprovalLimitCents);
    }
  }
  function toggle(capability: AgentCapability, enabled: boolean) {
    setCapabilities((current) =>
      enabled ? [...current, capability] : current.filter((value) => value !== capability)
    );
  }
  async function save() {
    if (!tenantId || !selected) return;
    setSaving(true);
    setError(undefined);
    setSaved(undefined);
    try {
      const agent = await call<Agent>(`tenants/${tenantId}/agents`, 'POST', {
        name,
        templateId: selected.templateId,
        templateVersion: selected.version,
        modelId,
        awsConnectionId: connectionId,
        capabilities,
        guardrails: {
          refunds: refundsEnabled
            ? {
                enabled: true,
                autoApprovalLimitCents: refundLimit,
                currency: selected.guardrails.refunds.currency
              }
            : { enabled: false }
        }
      });
      setSaved(agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save the agent draft.');
    } finally {
      setSaving(false);
    }
  }
  async function deploy() {
    if (!tenantId || !saved) return;
    setDeploying(true);
    setError(undefined);
    try {
      const result = await call<{ deploymentId: string }>(
        `tenants/${tenantId}/agents/${saved.id}/deploy`,
        'POST',
        {},
        { 'idempotency-key': `deploy-${crypto.randomUUID()}` }
      );
      window.location.assign(`/agents/${saved.id}/deployments/${result.deploymentId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start deployment.');
      setDeploying(false);
    }
  }

  return (
    <Card maxWidth="760px" padding={4}>
      <VStack gap={4}>
        <Heading level={2}>Agent templates</Heading>
        {loading ? (
          <Banner
            status="info"
            title="Loading templates"
            description="Loading platform templates and verified AWS targets."
          />
        ) : null}
        {error ? (
          <Banner status="error" title="Configuration needs attention" description={error} />
        ) : null}
        {!loading && !selected ? (
          <Banner
            status="warning"
            title="Customer Support Agent unavailable"
            description="No active Customer Support Agent template is currently available."
          />
        ) : null}
        {selected ? (
          <>
            <Selector
              label="Template"
              value={selected.templateId}
              onChange={chooseTemplate}
              options={(templates ?? [])
                .filter((item) => item.status === 'ACTIVE')
                .map((item) => item.templateId)}
              width="100%"
            />
            <Text as="p" color="secondary">
              {selected.description} Version {selected.version}.
            </Text>
            <Heading level={3}>General</Heading>
            <TextInput
              label="Agent name"
              value={name}
              onChange={setName}
              isRequired
              width="100%"
              status={
                !name.trim() ? { type: 'error', message: 'Agent name is required.' } : undefined
              }
            />
            <Heading level={3}>AI model</Heading>
            <Selector
              label="Bedrock model"
              value={modelId}
              onChange={setModelId}
              options={supportedModelIds}
              isDisabled={!target || supportedModelIds.length === 0}
              disabledMessage="Select a verified AWS connection with a Region that supports this model."
              width="100%"
            />
            <Heading level={3}>Deployment target</Heading>
            <Selector
              label="Verified AWS connection"
              value={connectionId}
              onChange={setConnectionId}
              options={(connections ?? [])
                .filter((item) => item.status === 'VERIFIED')
                .map((item) => item.id)}
              width="100%"
            />
            {!target ? (
              <Banner
                status="warning"
                title="No verified AWS account"
                description="Verify an AWS connection before saving this agent."
              />
            ) : (
              <Text as="p" color="secondary">
                AWS account {target.accountId} · {target.region}
              </Text>
            )}
            <Heading level={3}>Capabilities</Heading>
            {selected.supportedCapabilities.map((capability) => (
              <Switch
                key={capability}
                label={labels[capability]}
                value={capabilities.includes(capability)}
                onChange={(enabled: boolean) => toggle(capability, enabled)}
              />
            ))}
            <Heading level={3}>Governance</Heading>
            <NumberInput
              label="Automatic refund approval limit"
              value={refundLimit}
              onChange={setRefundLimit}
              min={1}
              max={selected.guardrails.refunds.maximumAutoApprovalLimitCents}
              step={1}
              isIntegerOnly
              units="pence"
              isDisabled={!refundsEnabled}
              disabledMessage="Enable Process refunds to set the automatic approval limit."
              description={`Maximum ${selected.guardrails.refunds.maximumAutoApprovalLimitCents} ${selected.guardrails.refunds.currency} minor units.`}
              width="100%"
            />
            <Heading level={3}>Summary</Heading>
            <Text as="p">
              Customer Support Agent v{selected.version} · {modelId} ·{' '}
              {target ? `${target.accountId} / ${target.region}` : 'No target selected'}
            </Text>
            <Text as="p" color="secondary">
              Capabilities: {capabilities.map((value) => labels[value]).join(', ') || 'None'}.{' '}
              {refundsEnabled
                ? `Refunds auto-approve up to £${(refundLimit / 100).toFixed(2)}.`
                : 'Refunds are disabled.'}
            </Text>
            {saved ? (
              <Banner
                status="success"
                title="Draft saved"
                description={`Agent ${saved.name} is saved as DRAFT (revision ${saved.revision}).`}
              />
            ) : null}
            <Button
              label="Save Agent"
              onClick={save}
              isLoading={saving}
              isDisabled={!target || !name.trim()}
            />
            {saved ? (
              <Button label="Deploy saved configuration" onClick={deploy} isLoading={deploying} />
            ) : null}
          </>
        ) : null}
      </VStack>
    </Card>
  );
}

async function call<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const response = await fetch(`/api/control/${path}`, {
    method,
    ...(headers ? { headers } : {}),
    ...(body === undefined
      ? {}
      : { headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? 'Control API request failed.');
  return value.data as T;
}
