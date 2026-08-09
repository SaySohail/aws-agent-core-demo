import { AppShell } from '@astryxdesign/core/AppShell';
import { redirect } from 'next/navigation';
import { currentSession } from '../../../../lib/auth';
import { AgentObservability } from '../../../dashboard/agent-observability';

export default async function ObservabilityPage({
  params
}: Readonly<{ params: Promise<{ agentId: string }> }>) {
  const session = await currentSession();
  if (!session) redirect('/login?error=expired');
  const { agentId } = await params;
  return (
    <AppShell contentPadding={4} height="auto" mobileNav={false} variant="elevated">
      <AgentObservability agentId={agentId} />
    </AppShell>
  );
}
