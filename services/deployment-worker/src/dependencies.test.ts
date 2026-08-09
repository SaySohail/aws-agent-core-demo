import assert from 'node:assert/strict';
import test from 'node:test';
import { agentResourceIdentifier, dependencyStackName } from './dependencies.js';

test('dependency stack names are deterministic and agent-scoped', () => {
  const first = dependencyStackName('agt_alpha-001');
  const second = dependencyStackName('agt_alpha-001');
  const other = dependencyStackName('agt_beta-001');
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^AgentLaunchpadAgent-[a-z0-9-]+-[a-f0-9]{12}$/);
  assert.doesNotMatch(first, /Bootstrap|DeploymentRole|Artifact/);
});

test('agent physical identifiers are deterministic, sanitized, and collision-resistant', () => {
  const normalizedCollisionA = agentResourceIdentifier('agent/a');
  const normalizedCollisionB = agentResourceIdentifier('agent_a');
  assert.equal(agentResourceIdentifier('agent/a'), normalizedCollisionA);
  assert.notEqual(normalizedCollisionA, normalizedCollisionB);
  assert.match(normalizedCollisionA, /^[a-z0-9][a-z0-9-]*-[a-f0-9]{12}$/);
});
