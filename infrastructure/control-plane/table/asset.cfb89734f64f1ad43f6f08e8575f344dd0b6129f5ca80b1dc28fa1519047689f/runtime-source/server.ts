import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  runtimeInvocationRequestSchema,
  runtimeResponseSchema,
  type RuntimeResponse
} from '@agent-launchpad/schemas';

export const DEFAULT_PORT = 8080;
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export type HealthStatus = 'Healthy' | 'HealthyBusy';
export type InvocationHandler = (prompt: string) => Promise<RuntimeResponse> | RuntimeResponse;

export interface RuntimeOptions {
  readonly getHealthStatus?: () => HealthStatus;
  readonly invoke?: InvocationHandler;
}

interface SafeInvocationError extends Error {
  readonly code: string;
}

function isSafeInvocationError(error: unknown): error is SafeInvocationError {
  return (
    error instanceof Error &&
    [
      'MODEL_TIMEOUT',
      'MODEL_THROTTLED',
      'MODEL_UNAVAILABLE',
      'INVALID_MODEL_RESPONSE',
      'TOOL_UNAVAILABLE',
      'TOOL_VALIDATION_ERROR',
      'TOOL_EXECUTION_ERROR',
      'TOOL_ITERATION_LIMIT',
      'UNKNOWN_TOOL'
    ].includes((error as SafeInvocationError).code)
  );
}

class RequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }

  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: RequestError): void {
  sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers['content-type'];
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();

  if (mediaType !== 'application/json') {
    throw new RequestError(400, 'INVALID_REQUEST', 'Content-Type must be application/json.');
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const settle = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        callback();
      }
    };

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        settle(() =>
          reject(new RequestError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'))
        );
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    request.on('aborted', () =>
      settle(() => reject(new RequestError(400, 'INVALID_REQUEST', 'Request was aborted.')))
    );
    request.on('error', () =>
      settle(() => reject(new RequestError(400, 'INVALID_REQUEST', 'Unable to read request body.')))
    );
  });
}

async function parseInvocationRequest(request: IncomingMessage): Promise<string> {
  requireJsonContentType(request);
  const body = await readRequestBody(request);

  if (body.trim().length === 0) {
    throw new RequestError(400, 'INVALID_REQUEST', 'Request body is required.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }

  const validated = runtimeInvocationRequestSchema.safeParse(parsed);
  if (!validated.success)
    throw new RequestError(400, 'INVALID_REQUEST', 'prompt must be a non-empty string.');
  return validated.data.prompt;
}

export function createRuntimeServer(options: RuntimeOptions = {}): Server {
  const getHealthStatus = options.getHealthStatus ?? (() => 'Healthy' as const);
  const invoke =
    options.invoke ?? (() => Promise.reject(new Error('Invocation handler is not configured.')));

  return createServer((request, response) => {
    void (async () => {
      try {
        const method = request.method ?? 'GET';
        const path = new URL(request.url ?? '/', 'http://runtime.local').pathname;

        if (path === '/ping') {
          if (method !== 'GET') {
            response.setHeader('Allow', 'GET');
            throw new RequestError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
          }
          sendJson(response, 200, { status: getHealthStatus() });
          return;
        }

        if (path === '/invocations') {
          if (method !== 'POST') {
            response.setHeader('Allow', 'POST');
            throw new RequestError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
          }
          const prompt = await parseInvocationRequest(request);
          const result = runtimeResponseSchema.parse(await invoke(prompt));
          sendJson(response, 200, result);
          return;
        }

        throw new RequestError(404, 'NOT_FOUND', 'Route not found.');
      } catch (error) {
        if (error instanceof RequestError) {
          sendError(response, error);
          return;
        }

        if (isSafeInvocationError(error)) {
          const statusCode = error.code === 'MODEL_TIMEOUT' ? 504 : 503;
          sendJson(response, statusCode, { error: { code: error.code, message: error.message } });
          return;
        }

        console.error('Runtime request failed.');
        sendJson(response, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }
        });
      }
    })();
  });
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return port;
}

export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
