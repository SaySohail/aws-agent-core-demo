'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useEffect, useState } from 'react';
import type { AwsConnectionOnboarding } from '../../lib/control-api';
import { useActiveTenant } from '../../lib/active-tenant';

const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-west-2'];

export function AwsConnectionOnboarding() {
  const { tenant, isLoading: isTenantLoading } = useActiveTenant();
  const tenantId = tenant?.tenantId;
  const [accountId, setAccountId] = useState('');
  const [region, setRegion] = useState(regions[0]);
  const [connection, setConnection] = useState<AwsConnectionOnboarding>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let isCurrent = true;

    async function load() {
      setError(undefined);
      setConnection(undefined);

      if (isTenantLoading) return;
      if (!tenantId) {
        setError('No active tenant membership is available.');
        return;
      }

      try {
        const listed = await call<AwsConnectionOnboarding[]>(
          `tenants/${tenantId}/aws-connections`
        );
        if (isCurrent) setConnection(listed.find((item) => item.status !== 'DISCONNECTED'));
      } catch {
        if (isCurrent) setError('Unable to load AWS connection settings.');
      }
    }

    void load();
    return () => {
      isCurrent = false;
    };
  }, [isTenantLoading, tenantId]);
  async function create() {
    if (!tenantId) return;
    setLoading(true);
    setError(undefined);
    try {
      setConnection(
        await call<AwsConnectionOnboarding>(`tenants/${tenantId}/aws-connections`, 'POST', {
          accountId,
          region
        })
      );
    } catch {
      setError('Could not create the connection. Confirm the account ID and try again.');
    } finally {
      setLoading(false);
    }
  }
  async function verify() {
    if (!tenantId || !connection) return;
    setLoading(true);
    setError(undefined);
    try {
      setConnection(
        await call<AwsConnectionOnboarding>(
          `tenants/${tenantId}/aws-connections/${connection.id}/verify`,
          'POST',
          {}
        )
      );
    } catch {
      setError('Verification did not succeed yet. Confirm CREATE_COMPLETE, then retry.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <Card maxWidth="640px" padding={4}>
      <VStack gap={3}>
        <Heading level={2}>Connect AWS account</Heading>
        {error ? (
          <Banner status="error" title="AWS connection needs attention" description={error} />
        ) : null}
        {!connection ? (
          <>
            <TextInput
              label="AWS account ID"
              value={accountId}
              onChange={setAccountId}
              isRequired
              description="12-digit customer AWS account ID."
              width="100%"
            />
            <Selector
              label="AWS Region"
              value={region}
              onChange={setRegion}
              options={regions}
              isRequired
              width="100%"
            />
            <Button label="Create connection" onClick={create} isLoading={loading} />
          </>
        ) : (
          <>
            {connection.status === 'VERIFIED' ? (
              <Banner
                status="success"
                title="AWS account verified"
                description={`${connection.accountId} in ${connection.region}`}
              />
            ) : (
              <Banner
                status={connection.status === 'FAILED' ? 'error' : 'info'}
                title={
                  connection.status === 'VERIFYING'
                    ? 'Verifying AWS connection'
                    : 'Install the AWS bootstrap stack'
                }
                description="Launch CloudFormation, wait for CREATE_COMPLETE, then verify."
              />
            )}
            {connection.status !== 'VERIFIED' && connection.quickCreateUrl ? (
              <Button
                label="Launch AWS CloudFormation"
                href={connection.quickCreateUrl}
                target="_blank"
                variant="secondary"
              />
            ) : null}
            {connection.status !== 'VERIFIED' ? (
              <Button label="Verify connection" onClick={verify} isLoading={loading} />
            ) : null}
          </>
        )}
      </VStack>
    </Card>
  );
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/control/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  });
  const value = await response.json();
  if (!response.ok) throw new Error('Control API request failed.');
  return value.data as T;
}
