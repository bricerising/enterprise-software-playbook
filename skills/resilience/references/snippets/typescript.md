# TypeScript Resilience Snippets

Starter shapes for systemic TypeScript resilience patterns following the playbook's conventions. These use closures and factory functions (not classes) and return typed `Result` values so callers handle outcomes explicitly.

## Shared Result Type

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

## 1) Retry With Backoff + Jitter

Accepts an `AbortSignal` for cancellation and a classifier to decide which errors are retryable.

```ts
export interface RetryOpts<E> {
  maxAttempts: number;
  baseMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  isRetryable: (error: E) => boolean;
}

function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = 0.5 + Math.random(); // [0.5, 1.5)
  return Math.round(exp * jitter);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export async function withRetry<T, E>(
  fn: () => Promise<Result<T, E>>,
  opts: RetryOpts<E>,
): Promise<Result<T, E>> {
  const { maxAttempts, baseMs = 100, maxDelayMs = 2_000, signal, isRetryable } = opts;
  let lastResult: Result<T, E> | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return err(signal.reason as E);

    lastResult = await fn();
    if (lastResult.ok) return lastResult;
    if (!isRetryable(lastResult.error)) return lastResult;
    if (attempt < maxAttempts - 1) {
      await sleep(backoffMs(attempt, baseMs, maxDelayMs), signal);
    }
  }

  return lastResult!;
}
```

## 2) Circuit Breaker

Counts failures, opens after a threshold, fails fast while open, probes on half-open.

```ts
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOpts {
  failureThreshold: number;
  cooldownMs: number;
}

export function createCircuitBreaker(opts: BreakerOpts) {
  const { failureThreshold, cooldownMs } = opts;
  let failures = 0;
  let state: BreakerState = 'closed';
  let openedAt = 0;

  function getState(): BreakerState {
    if (state === 'open' && Date.now() - openedAt >= cooldownMs) {
      state = 'half-open';
    }
    return state;
  }

  async function call<T, E>(fn: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    const current = getState();
    if (current === 'open') {
      return err('circuit_open' as unknown as E);
    }

    const result = await fn();

    if (result.ok) {
      failures = 0;
      state = 'closed';
    } else {
      failures += 1;
      if (failures >= failureThreshold) {
        state = 'open';
        openedAt = Date.now();
      }
    }

    return result;
  }

  return { call, getState };
}
```

## 3) Timeout Wrapper

Races work against an `AbortSignal` deadline.

```ts
export async function withTimeout<T, E>(
  fn: (signal: AbortSignal) => Promise<Result<T, E>>,
  timeoutMs: number,
): Promise<Result<T, E>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      return err('timeout' as unknown as E);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

## 4) Bulkhead / Concurrency Limiter

Semaphore pattern -- bounds concurrent work per dependency.

```ts
export function createBulkhead(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      next(); // hand the slot directly to the next waiter
    } else {
      active--;
    }
  }

  async function run<T, E>(fn: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, getActive: () => active, getWaiting: () => waiting.length };
}
```

## 5) Idempotency Key Check

Prevents double-apply by checking a seen-keys store before executing work.

```ts
export interface IdempotencyStore {
  has(key: string): Promise<boolean>;
  set(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown | undefined>;
}

export async function withIdempotencyCheck<T, E>(
  key: string,
  store: IdempotencyStore,
  fn: () => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  if (await store.has(key)) {
    const cached = await store.get(key);
    return ok(cached as T);
  }

  const result = await fn();
  if (result.ok) {
    await store.set(key, result.value);
  }
  return result;
}
```

## Verification Checklist

- Retry attempts are bounded and jitter prevents synchronized storms.
- Circuit breaker opens under repeated failures and closes after recovery.
- Timeout wrapper always clears the timer, including on success paths.
- Bulkhead limits hold under concurrent load; waiters are drained FIFO.
- Idempotency check returns the cached result for duplicate keys without re-executing work.
