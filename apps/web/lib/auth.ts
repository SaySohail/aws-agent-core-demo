import { cookies } from 'next/headers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  createPkceChallenge,
  createRandomValue,
  safeReturnPath,
  sessionFromClaims,
  statesMatch,
  type UserSession
} from './auth-protocol';

const ID_TOKEN_COOKIE = 'agent_launchpad_id_token';
const OAUTH_STATE_COOKIE = 'agent_launchpad_oauth_state';
const PKCE_VERIFIER_COOKIE = 'agent_launchpad_pkce_verifier';
const RETURN_TO_COOKIE = 'agent_launchpad_return_to';
const TRANSIENT_COOKIE_MAX_AGE_SECONDS = 10 * 60;

interface AuthConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly domain: string;
}

function requiredHttpsUrl(variableName: 'COGNITO_ISSUER' | 'COGNITO_DOMAIN'): URL {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`${variableName} must be configured.`);
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.search || url.hash) {
    throw new Error(`${variableName} must be an HTTPS URL without query parameters or fragments.`);
  }
  return url;
}

function requiredCognitoIssuer(): string {
  const url = requiredHttpsUrl('COGNITO_ISSUER');
  if (url.pathname === '/') {
    throw new Error('COGNITO_ISSUER must include the Cognito user pool ID.');
  }
  return url.toString().replace(/\/$/, '');
}

function requiredHttpsOrigin(variableName: 'COGNITO_DOMAIN'): string {
  const url = requiredHttpsUrl(variableName);
  if (url.pathname !== '/') {
    throw new Error(`${variableName} must be an HTTPS origin.`);
  }
  return url.origin;
}

function configuration(): AuthConfiguration {
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!clientId) {
    throw new Error('COGNITO_CLIENT_ID must be configured.');
  }
  return {
    issuer: requiredCognitoIssuer(),
    clientId,
    domain: requiredHttpsOrigin('COGNITO_DOMAIN')
  };
}

function cookieOptions(maxAge: number, path = '/') {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path,
    maxAge
  };
}

export async function startLogin(returnTo: string | null): Promise<string> {
  const config = configuration();
  const state = createRandomValue();
  const verifier = createRandomValue();
  const store = await cookies();
  store.set(
    OAUTH_STATE_COOKIE,
    state,
    cookieOptions(TRANSIENT_COOKIE_MAX_AGE_SECONDS, '/auth/callback')
  );
  store.set(
    PKCE_VERIFIER_COOKIE,
    verifier,
    cookieOptions(TRANSIENT_COOKIE_MAX_AGE_SECONDS, '/auth/callback')
  );
  store.set(
    RETURN_TO_COOKIE,
    safeReturnPath(returnTo),
    cookieOptions(TRANSIENT_COOKIE_MAX_AGE_SECONDS, '/auth/callback')
  );

  const authorizationUrl = new URL('/oauth2/authorize', config.domain);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: `${applicationOrigin()}/auth/callback`,
    scope: 'openid email profile',
    state,
    code_challenge_method: 'S256',
    code_challenge: createPkceChallenge(verifier)
  }).toString();
  return authorizationUrl.toString();
}

function applicationOrigin(): string {
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const url = new URL(origin);
  if (url.origin !== origin) {
    throw new Error('APP_ORIGIN must be an origin without a path.');
  }
  return url.origin;
}

export async function completeLogin(
  code: string | null,
  state: string | null
): Promise<UserSession | null> {
  if (!code) {
    return null;
  }
  const store = await cookies();
  const expectedState = store.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = store.get(PKCE_VERIFIER_COOKIE)?.value;
  if (!statesMatch(expectedState, state) || !verifier) {
    return null;
  }

  const config = configuration();
  const tokenResponse = await fetch(new URL('/oauth2/token', config.domain), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: `${applicationOrigin()}/auth/callback`,
      code_verifier: verifier
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  });
  if (!tokenResponse.ok) {
    return null;
  }
  const payload: unknown = await tokenResponse.json();
  if (!isTokenResponse(payload)) {
    return null;
  }
  const session = await verifyIdToken(payload.id_token, config);
  if (!session) {
    return null;
  }
  store.set(ID_TOKEN_COOKIE, payload.id_token, cookieOptions(60 * 60));
  return session;
}

function isTokenResponse(payload: unknown): payload is { id_token: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { id_token?: unknown }).id_token === 'string'
  );
}

async function verifyIdToken(token: string, config = configuration()): Promise<UserSession | null> {
  try {
    const jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', `${config.issuer}/`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.clientId
    });
    return sessionFromClaims(payload);
  } catch {
    return null;
  }
}

export async function currentSession(): Promise<UserSession | null> {
  const token = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  return token ? verifyIdToken(token) : null;
}

export async function finishLogin(): Promise<string> {
  const store = await cookies();
  const returnTo = safeReturnPath(store.get(RETURN_TO_COOKIE)?.value);
  for (const name of [OAUTH_STATE_COOKIE, PKCE_VERIFIER_COOKIE, RETURN_TO_COOKIE]) {
    store.set(name, '', cookieOptions(0, '/auth/callback'));
  }
  return returnTo;
}

export async function logoutUrl(): Promise<string> {
  const store = await cookies();
  store.delete(ID_TOKEN_COOKIE);
  const config = configuration();
  const logoutUrl = new URL('/logout', config.domain);
  logoutUrl.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: `${applicationOrigin()}/login`
  }).toString();
  return logoutUrl.toString();
}
