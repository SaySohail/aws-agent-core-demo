import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPkceChallenge,
  safeReturnPath,
  sessionFromClaims,
  statesMatch
} from './auth-protocol';

test('creates the RFC 7636 S256 PKCE challenge', () => {
  assert.equal(
    createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
});

test('accepts only internal return paths', () => {
  assert.equal(safeReturnPath('/dashboard?tab=activity'), '/dashboard?tab=activity');
  assert.equal(safeReturnPath('https://attacker.example'), '/dashboard');
  assert.equal(safeReturnPath('//attacker.example'), '/dashboard');
});

test('rejects an OAuth state mismatch', () => {
  assert.equal(statesMatch('expected', 'expected'), true);
  assert.equal(statesMatch('expected', 'received'), false);
  assert.equal(statesMatch(undefined, 'received'), false);
});

test('creates a session only from a Cognito ID token subject and email', () => {
  assert.deepEqual(
    sessionFromClaims({ token_use: 'id', sub: 'cognito-sub', email: 'user@example.com' }),
    {
      user: { id: 'cognito-sub', email: 'user@example.com' },
      tenant: null
    }
  );
  assert.equal(
    sessionFromClaims({ token_use: 'access', sub: 'cognito-sub', email: 'user@example.com' }),
    null
  );
  assert.equal(sessionFromClaims({ token_use: 'id', sub: 'cognito-sub' }), null);
});
