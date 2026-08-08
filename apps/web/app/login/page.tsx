import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AUTHENTICATION_ERROR_MESSAGES } from '../../lib/auth-protocol';

export default async function LoginPage({
  searchParams
}: Readonly<{
  searchParams: Promise<{ error?: keyof typeof AUTHENTICATION_ERROR_MESSAGES; returnTo?: string }>;
}>) {
  const { error, returnTo } = await searchParams;
  const loginHref = `/auth/login?returnTo=${encodeURIComponent(returnTo ?? '/dashboard')}`;
  return (
    <Center axis="both" minHeight="100dvh" padding={4}>
      <Card elevation="low" maxWidth={400} padding={8} width="100%">
        <VStack gap={4} hAlign="stretch">
          <VStack gap={1} hAlign="center">
            <Text as="h1" type="display-1">
              Welcome back
            </Text>
            <Text as="p" color="secondary" size="sm">
              Sign in to access the Agent Launchpad control-plane dashboard.
            </Text>
          </VStack>
          {error ? (
            <Text as="p" color="danger">
              {AUTHENTICATION_ERROR_MESSAGES[error] ?? AUTHENTICATION_ERROR_MESSAGES.callback}
            </Text>
          ) : null}
          <Button
            href={loginHref}
            label="Sign in with SSO"
            size="lg"
            variant="primary"
            width="100%"
          />
        </VStack>
      </Card>
    </Center>
  );
}
