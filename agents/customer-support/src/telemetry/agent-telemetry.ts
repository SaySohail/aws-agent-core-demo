/**
 * The Runtime only records attributes from this allowlist.  In particular, this
 * boundary must never receive prompts, model output, tool arguments, or AWS
 * credentials.
 */
export type SafeTelemetryAttributeValue = string | number | boolean;

export type SafeTelemetryAttributeName =
  | 'agent.id'
  | 'deployment.id'
  | 'runtime.version'
  | 'endpoint.name'
  | 'model.id'
  | 'tool.name'
  | 'tool.status'
  | 'policy.decision'
  | 'error.code'
  | 'duration.ms';

export type SafeTelemetryAttributes = Readonly<
  Partial<Record<SafeTelemetryAttributeName, SafeTelemetryAttributeValue>>
>;

const safeAttributeNames = new Set<SafeTelemetryAttributeName>([
  'agent.id',
  'deployment.id',
  'runtime.version',
  'endpoint.name',
  'model.id',
  'tool.name',
  'tool.status',
  'policy.decision',
  'error.code',
  'duration.ms'
]);

/** Runtime guard for callers outside TypeScript's type system. */
export function safeTelemetryAttributes(
  attributes: SafeTelemetryAttributes
): SafeTelemetryAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([name, value]) =>
        safeAttributeNames.has(name as SafeTelemetryAttributeName) &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    )
  ) as SafeTelemetryAttributes;
}

export interface AgentTelemetrySpan {
  setAttributes(attributes: SafeTelemetryAttributes): void;
}

/** Small application boundary over OpenTelemetry, intentionally not a framework. */
export interface AgentTelemetry {
  withSpan<T>(
    name: string,
    attributes: SafeTelemetryAttributes,
    fn: (span: AgentTelemetrySpan) => Promise<T>
  ): Promise<T>;
}

const noopSpan: AgentTelemetrySpan = { setAttributes: () => undefined };

export class NoopAgentTelemetry implements AgentTelemetry {
  public async withSpan<T>(
    _name: string,
    _attributes: SafeTelemetryAttributes,
    fn: (span: AgentTelemetrySpan) => Promise<T>
  ): Promise<T> {
    return fn(noopSpan);
  }
}

interface OpenTelemetrySpan {
  setAttributes(attributes: SafeTelemetryAttributes): void;
  recordException(error: Error): void;
  setStatus(status: { code: number }): void;
  end(): void;
}

interface OpenTelemetryTracer {
  startSpan(name: string, options: { attributes: SafeTelemetryAttributes }): OpenTelemetrySpan;
}

/**
 * Uses the API installed by ADOT at runtime. The dynamic require deliberately
 * keeps local development and unit tests independent of the instrumentation.
 */
export class OpenTelemetryAgentTelemetry implements AgentTelemetry {
  public constructor(private readonly tracer = loadTracer()) {}

  public async withSpan<T>(
    name: string,
    attributes: SafeTelemetryAttributes,
    fn: (span: AgentTelemetrySpan) => Promise<T>
  ): Promise<T> {
    if (!this.tracer) return fn(noopSpan);
    const span = this.tracer.startSpan(name, { attributes: safeTelemetryAttributes(attributes) });
    try {
      return await fn({
        setAttributes: (next) => span.setAttributes(safeTelemetryAttributes(next))
      });
    } catch (error) {
      const exception = error instanceof Error ? error : new Error('Unknown agent operation error');
      span.recordException(exception);
      span.setStatus({ code: 2 }); // OpenTelemetry SpanStatusCode.ERROR
      throw error;
    } finally {
      span.end();
    }
  }
}

function loadTracer(): OpenTelemetryTracer | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require('@opentelemetry/api') as {
      trace?: { getTracer(name: string): OpenTelemetryTracer };
    };
    return api.trace?.getTracer('agent-launchpad.customer-support');
  } catch {
    return undefined;
  }
}

export interface AgentTelemetryLogger {
  error(event: Record<string, unknown>): void;
}

/**
 * Telemetry is optional operational data: a broken exporter/recorder can never
 * alter the Runtime result or repeat a tool side effect.
 */
export async function withFailOpenSpan<T>(
  telemetry: AgentTelemetry,
  logger: AgentTelemetryLogger,
  name: string,
  attributes: SafeTelemetryAttributes,
  operation: (span: AgentTelemetrySpan) => Promise<T>
): Promise<T> {
  let operationStarted = false;
  let operationFinished = false;
  let result: T | undefined;
  let operationError: unknown;
  const runOnce = async (span: AgentTelemetrySpan): Promise<T> => {
    operationStarted = true;
    try {
      result = await operation(span);
      operationFinished = true;
      return result;
    } catch (error) {
      operationError = error;
      throw error;
    }
  };

  try {
    return await telemetry.withSpan(name, attributes, runOnce);
  } catch (telemetryError) {
    if (operationError !== undefined) throw operationError;
    logger.error({
      event: 'telemetry_failed',
      span: name,
      errorCode: safeErrorCode(telemetryError)
    });
    if (operationStarted && operationFinished) return result as T;
    return runOnce(noopSpan);
  }
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 128) : 'TelemetryError';
}
