import { AppShell } from '@astryxdesign/core/AppShell';
import { redirect } from 'next/navigation';
import { currentSession } from '../../../../lib/auth';
import { AgentPlayground } from '../../../dashboard/agent-playground';

export default async function PlaygroundPage({
  params
}: Readonly<{ params: Promise<{ agentId: string }> }>) {
  const session = await currentSession();
  if (!session) redirect('/login?error=expired');
  const { agentId } = await params;
  return (
    <AppShell contentPadding={4} height="auto" mobileNav={false} variant="elevated">
      <AgentPlayground agentId={agentId} />
    </AppShell>
  );
}
