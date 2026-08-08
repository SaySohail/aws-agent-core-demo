import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JWTPayload } from 'jose';

export const AUTHENTICATION_ERROR_MESSAGES = {
  callback: 'We could not complete your sign-in. Please try again.',
  configuration: 'Sign-in is not configured for this environment yet.',
  expired: 'Your session has expired. Please sign in again.',
  provider: 'The identity provider could not complete your sign-in. Please try again.'
} as const;

export interface UserSession {
  readonly user: {
    readonly id: string;
    readonly email: string;
  };
  /** Tenant membership is intentionally introduced in SAY-93. */
  readonly tenant: null;
}

export function createRandomValue(): string {
  return randomBytes(32).toString('base64url');
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function isSafeReturnPath(value: string | null | undefined): value is string {
  return Boolean(
    value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
  );
}

export function safeReturnPath(value: string | null | undefined): string {
  return isSafeReturnPath(value) ? value : '/dashboard';
}

export function statesMatch(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received || expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function sessionFromClaims(claims: JWTPayload): UserSession | null {
  if (
    claims.token_use !== 'id' ||
    typeof claims.sub !== 'string' ||
    typeof claims.email !== 'string'
  ) {
    return null;
  }
  return {
    user: { id: claims.sub, email: claims.email },
    tenant: null
  };
}
