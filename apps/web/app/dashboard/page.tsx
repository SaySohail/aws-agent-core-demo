import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth';
import { AwsConnectionOnboarding } from './aws-connection';
import { AgentTemplateCatalog } from './agent-catalog';
import { ActiveTenantSelector } from './active-tenant-selector';
import { DashboardSettings } from './dashboard-settings';

export default async function DashboardPage() {
  const session = await currentSession();
  if (!session) {
    redirect('/login?error=expired&returnTo=%2Fdashboard');
  }
  return (
    <DashboardSettings email={session.user.email}>
      <ActiveTenantSelector />
      <AwsConnectionOnboarding />
      <AgentTemplateCatalog />
    </DashboardSettings>
  );
}
