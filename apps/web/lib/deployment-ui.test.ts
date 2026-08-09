import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentPollingInterval, sortedEvents } from '../app/dashboard/deployment-detail';
import { activityState } from '../app/dashboard/agent-playground';

test('deployment polling continues until READY and preserves chronological deduplicated progress', () => {
  assert.equal(deploymentPollingInterval('IN_PROGRESS'), 2500);
  assert.equal(deploymentPollingInterval('READY'), false);
  assert.equal(deploymentPollingInterval('FAILED'), false);
  const events = sortedEvents([
    {
      id: 'dpe_00000000-0000-4000-8000-000000000002',
      deploymentId: 'dep_00000000-0000-4000-8000-000000000001',
      toStage: 'READY',
      status: 'READY',
      createdAt: '2026-01-02T00:00:00.000Z'
    },
    {
      id: 'dpe_00000000-0000-4000-8000-000000000001',
      deploymentId: 'dep_00000000-0000-4000-8000-000000000001',
      toStage: 'PREFLIGHT_AGENTCORE',
      status: 'IN_PROGRESS',
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'dpe_00000000-0000-4000-8000-000000000001',
      deploymentId: 'dep_00000000-0000-4000-8000-000000000001',
      toStage: 'PREFLIGHT_AGENTCORE',
      status: 'IN_PROGRESS',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ] as never);
  assert.deepEqual(
    events.map((event) => event.id),
    ['dpe_00000000-0000-4000-8000-000000000001', 'dpe_00000000-0000-4000-8000-000000000002']
  );
});

test('playground presentation maps tool DENIED and error activity to visible status states', () => {
  assert.equal(activityState('SUCCEEDED'), 'success');
  assert.equal(activityState('DENIED'), 'warning');
  assert.equal(activityState('FAILED'), 'error');
});
