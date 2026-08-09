import { AppShell } from '@astryxdesign/core/AppShell';
import { redirect } from 'next/navigation';
import { currentSession } from '../../../../../lib/auth';
import { DeploymentDetail } from '../../../../dashboard/deployment-detail';

export default async function DeploymentPage({
  params
}: Readonly<{ params: Promise<{ agentId: string; deploymentId: string }> }>) {
  const session = await currentSession();
  if (!session) redirect('/login?error=expired');
  const { deploymentId } = await params;
  return (
    <AppShell contentPadding={4} height="auto" mobileNav={false} variant="elevated">
      <DeploymentDetail deploymentId={deploymentId} />
    </AppShell>
  );
}
