'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createControlApiClient, type TenantMembershipSummary } from './control-api';

const ACTIVE_TENANT_STORAGE_KEY = 'agent-launchpad.active-tenant';

const api = () =>
  createControlApiClient({
    baseUrl: `${window.location.origin}/api/control`,
    getAccessToken: () => null
  });

export function selectActiveTenant(
  memberships: readonly TenantMembershipSummary[],
  persistedTenantId: string | null
): TenantMembershipSummary | undefined {
  return (
    memberships.find((membership) => membership.tenantId === persistedTenantId) ?? memberships[0]
  );
}

interface ActiveTenantContextValue {
  readonly tenant: TenantMembershipSummary | undefined;
  readonly memberships: readonly TenantMembershipSummary[];
  readonly isLoading: boolean;
  readonly selectTenant: (tenantId: string) => void;
}

const ActiveTenantContext = createContext<ActiveTenantContextValue | undefined>(undefined);

export function ActiveTenantProvider({ children }: Readonly<{ children: ReactNode }>) {
  const queryClient = useQueryClient();
  const membership = useQuery({ queryKey: ['me'], queryFn: () => api().me.get() });
  const [persistedTenantId, setPersistedTenantId] = useState<string | null>(null);

  useEffect(() => {
    setPersistedTenantId(window.localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY));
  }, []);

  const tenant = selectActiveTenant(membership.data?.tenants ?? [], persistedTenantId);
  const selectTenant = (tenantId: string) => {
    if (!membership.data?.tenants.some((item) => item.tenantId === tenantId)) return;
    window.localStorage.setItem(ACTIVE_TENANT_STORAGE_KEY, tenantId);
    setPersistedTenantId(tenantId);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
  };
  const value = useMemo(
    () => ({
      tenant,
      memberships: membership.data?.tenants ?? [],
      isLoading: membership.isLoading,
      selectTenant
    }),
    [tenant, membership.data?.tenants, membership.isLoading]
  );
  return <ActiveTenantContext.Provider value={value}>{children}</ActiveTenantContext.Provider>;
}

export function useActiveTenant(): ActiveTenantContextValue {
  const value = useContext(ActiveTenantContext);
  if (!value) throw new Error('useActiveTenant must be used inside ActiveTenantProvider.');
  return value;
}
