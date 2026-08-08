import { z } from 'zod';

const cursorSchema = z.object({ version: z.literal(1), key: z.record(z.string()) });

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextToken?: string;
}

export function page<T>(items: readonly T[], nextToken: string | undefined): Page<T> {
  return nextToken ? { items, nextToken } : { items };
}

export function encodePageToken(key: Record<string, string> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify({ version: 1, key }), 'utf8').toString('base64url');
}

export function decodePageToken(token: string | undefined): Record<string, string> | undefined {
  if (!token) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))).key;
  } catch {
    throw new Error('Invalid pagination token.');
  }
}
