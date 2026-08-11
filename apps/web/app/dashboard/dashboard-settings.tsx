'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useState, type ReactNode } from 'react';

type Panel = 'Overview' | 'Workspace' | 'AWS connections' | 'Agent defaults' | 'Notifications';

const panels: Panel[] = [
  'Overview',
  'Workspace',
  'AWS connections',
  'Agent defaults',
  'Notifications'
];

export function DashboardSettings({ email, children }: { email: string; children: ReactNode }) {
  const [activePanel, setActivePanel] = useState<Panel>('Overview');

  return (
    <Layout
      height="fill"
      start={
        <LayoutPanel hasDivider padding={0} width={256}>
          <VStack gap={4} style={{ padding: 'var(--spacing-4)' }}>
            <VStack gap={1}>
              <Text color="secondary" type="supporting">
                Agent Launchpad
              </Text>
              <Heading level={2}>Workspace settings</Heading>
            </VStack>
            <List density="spacious">
              {panels.map((panel) => (
                <ListItem
                  key={panel}
                  label={panel}
                  isSelected={activePanel === panel}
                  onClick={() => setActivePanel(panel)}
                />
              ))}
            </List>
            <Divider />
            <Button href="/auth/logout" label="Sign out" variant="ghost" />
          </VStack>
        </LayoutPanel>
      }
    >
      <LayoutContent padding={5}>
        <VStack gap={5}>
          <VStack gap={1}>
            <Heading level={1}>{activePanel}</Heading>
            <Text as="p" color="secondary">
              {activePanel === 'Overview'
                ? 'Set up and manage the environment where your agents run.'
                : 'Configure workspace controls for your agent operations.'}
            </Text>
          </VStack>
          {activePanel === 'Overview' ? (
            <VStack gap={4}>{children}</VStack>
          ) : (
            <Card maxWidth="640px" padding={4}>
              <VStack gap={2}>
                <Heading level={2}>{activePanel}</Heading>
                <Text as="p" color="secondary">
                  This workspace is managed by {email}. Settings for this section will be available
                  as the control plane expands.
                </Text>
                <Banner
                  status="info"
                  title="Configuration panel coming soon"
                  description="Use Overview to connect AWS and create an agent today."
                />
              </VStack>
            </Card>
          )}
        </VStack>
      </LayoutContent>
    </Layout>
  );
}
