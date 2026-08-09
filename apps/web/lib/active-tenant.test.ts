import assert from 'node:assert/strict';
import test from 'node:test';
import { selectActiveTenant } from './active-tenant.js';

const memberships = [
  { tenantId: 'tnt_00000000-0000-4000-8000-000000000001', role: 'ADMIN' as const },
  { tenantId: 'tnt_00000000-0000-4000-8000-000000000002', role: 'MEMBER' as const }
];

test('active tenant defaults to the sole or first authorized membership', () => {
  assert.equal(selectActiveTenant([memberships[0]!], null)?.tenantId, memberships[0]!.tenantId);
  assert.equal(selectActiveTenant(memberships, null)?.tenantId, memberships[0]!.tenantId);
});

test('active tenant honors a persisted authorized selection but rejects foreign IDs', () => {
  assert.equal(
    selectActiveTenant(memberships, memberships[1]!.tenantId)?.tenantId,
    memberships[1]!.tenantId
  );
  assert.equal(selectActiveTenant(memberships, 'tnt_foreign')?.tenantId, memberships[0]!.tenantId);
});
