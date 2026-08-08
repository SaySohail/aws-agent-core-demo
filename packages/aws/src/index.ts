/**
 * Server-only AWS boundary. Browser-compatible credentials and client creation are intentionally
 * not exported from this package. Add server-side helpers only when AWS work is approved.
 */
export const awsPackageBoundary = 'server-only';
