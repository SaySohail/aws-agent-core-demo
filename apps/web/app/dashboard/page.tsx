import { AppShell } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth';

export default async function DashboardPage() {
  const session = await currentSession();
  if (!session) {
    redirect('/login?error=expired&returnTo=%2Fdashboard');
  }
  return (
    <AppShell contentPadding={4} height="auto" mobileNav={false} variant="elevated">
      <VStack gap={4}>
        <Heading level={1}>Control plane</Heading>
        <Card maxWidth="640px" padding={4}>
          <VStack gap={2}>
            <Heading level={2}>Signed in</Heading>
            <Text as="p">{session.user.email}</Text>
            <Text as="p" color="secondary">
              Your stable user ID is managed by Cognito.
            </Text>
            <Button href="/auth/logout" label="Sign out" variant="secondary" />
          </VStack>
        </Card>
      </VStack>
    </AppShell>
  );
}
