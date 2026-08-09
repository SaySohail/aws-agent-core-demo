'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Selector } from '@astryxdesign/core/Selector';
import { useActiveTenant } from '../../lib/active-tenant';

export function ActiveTenantSelector() {
  const { tenant, memberships, isLoading, selectTenant } = useActiveTenant();
  if (isLoading) return <Banner status="info" title="Loading tenant access" />;
  if (!tenant)
    return (
      <Banner
        status="error"
        title="No tenant membership"
        description="Your account does not currently have access to a tenant."
      />
    );
  if (memberships.length === 1) return null;
  return (
    <Selector
      label="Active tenant"
      value={tenant.tenantId}
      onChange={selectTenant}
      options={memberships.map((membership) => `${membership.tenantId}`)}
      description="All dashboard data and actions use this tenant."
      width="100%"
    />
  );
}
