# TypeScript Observability Snippets

Use these to standardize correlation across logs, traces, and metrics.

## 1) Add Trace IDs To Structured Logs

```ts
import { context, trace } from '@opentelemetry/api';

export function traceLogFields(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
```

## 2) Boundary Duration + Outcome Metric

```ts
import { Histogram } from 'prom-client';

const requestDurationSeconds = new Histogram({
  name: 'request_duration_seconds',
  help: 'Boundary request latency in seconds',
  labelNames: ['op', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10],
});

export async function observeBoundary<T>(
  op: string,
  work: () => Promise<T>,
): Promise<T> {
  const end = requestDurationSeconds.startTimer({ op });
  try {
    const result = await work();
    end({ status: 'ok' });
    return result;
  } catch (error) {
    end({ status: 'error' });
    throw error;
  }
}
```

## 3) Child Span Wrapper

```ts
import { context, trace, SpanStatusCode } from '@opentelemetry/api';

export async function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer('app');
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const value = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return value;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

## Verification Checklist

- Failing requests include `traceId` in logs.
- Metrics use bounded labels (`op`, `status`) only.
- Spans always end, including thrown/failure paths.
