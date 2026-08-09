import assert from 'node:assert/strict';
import test from 'node:test';
import { dependencyStackName } from './dependencies.js';

test('dependency stack names are deterministic and agent-scoped', () => {
  const first = dependencyStackName('agt_alpha-001');
  const second = dependencyStackName('agt_alpha-001');
  const other = dependencyStackName('agt_beta-001');
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^AgentLaunchpadAgent-[A-Za-z0-9]+$/);
  assert.doesNotMatch(first, /Bootstrap|DeploymentRole|Artifact/);
});
