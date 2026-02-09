# TypeScript Test Skeletons

Starter shapes for consumer-focused test suites following the playbook's conventions. These use Vitest syntax (`describe`/`it`/`expect`/`vi.fn`) and focus on the testing pattern, not a specific framework. Mock infra boundaries; assert consumer-visible behavior.

## 1) HTTP Handler Test

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace with your handler and service types
import type { OrderService } from '../src/services/order-service';
import { createOrderHandler } from '../src/handlers/create-order';

describe('POST /orders', () => {
  let service: OrderService;
  let handler: ReturnType<typeof createOrderHandler>;

  beforeEach(() => {
    service = {
      create: vi.fn(),
      getById: vi.fn(),
    } as unknown as OrderService;
    handler = createOrderHandler(service);
  });

  it('returns 201 with created order on valid input', async () => {
    const order = { id: 'ord_1', status: 'pending' };
    vi.mocked(service.create).mockResolvedValue(order);

    const res = await handler({
      body: { accountId: 'acct_1', amountCents: 500 },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(order);
    expect(service.create).toHaveBeenCalledOnce();
  });

  it('returns 400 on invalid input', async () => {
    const res = await handler({ body: {} });

    expect(res.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('returns 500 when service throws', async () => {
    vi.mocked(service.create).mockRejectedValue(new Error('db down'));

    const res = await handler({
      body: { accountId: 'acct_1', amountCents: 500 },
    });

    expect(res.status).toBe(500);
  });
});
```

## 2) gRPC Handler Test

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AccountService } from '../src/services/account-service';
import { createGetAccountHandler } from '../src/handlers/get-account';

describe('GetAccount RPC', () => {
  let service: AccountService;
  let handler: ReturnType<typeof createGetAccountHandler>;

  beforeEach(() => {
    service = {
      getById: vi.fn(),
    } as unknown as AccountService;
    handler = createGetAccountHandler(service);
  });

  it('returns account for valid id', async () => {
    const account = { id: 'acct_1', name: 'Acme' };
    vi.mocked(service.getById).mockResolvedValue(account);

    const res = await handler({ id: 'acct_1' });

    expect(res.value).toEqual(account);
  });

  it('returns NOT_FOUND for unknown id', async () => {
    vi.mocked(service.getById).mockResolvedValue(null);

    const res = await handler({ id: 'acct_unknown' });

    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('returns INTERNAL on service failure', async () => {
    vi.mocked(service.getById).mockRejectedValue(new Error('timeout'));

    const res = await handler({ id: 'acct_1' });

    expect(res.error?.code).toBe('INTERNAL');
  });
});
```

## 3) Event / Message Consumer Test

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { OrderRepo } from '../src/repos/order-repo';
import { createOrderEventConsumer } from '../src/consumers/order-events';

describe('OrderEvent consumer', () => {
  let repo: OrderRepo;
  let consume: ReturnType<typeof createOrderEventConsumer>;

  beforeEach(() => {
    repo = {
      upsert: vi.fn(),
      markProcessed: vi.fn(),
    } as unknown as OrderRepo;
    consume = createOrderEventConsumer(repo);
  });

  it('processes a valid OrderCreated event', async () => {
    const event = {
      type: 'OrderCreated',
      payload: { orderId: 'ord_1', amountCents: 1000 },
    };

    await consume(event);

    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'ord_1' }),
    );
  });

  it('skips unknown event types without error', async () => {
    await consume({ type: 'UnknownEvent', payload: {} });

    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('rejects event with missing required fields', async () => {
    const event = { type: 'OrderCreated', payload: {} };

    await expect(consume(event)).rejects.toThrow();
  });

  it('handles duplicate delivery idempotently', async () => {
    vi.mocked(repo.markProcessed).mockResolvedValueOnce(false); // already seen

    const event = {
      type: 'OrderCreated',
      payload: { orderId: 'ord_1', amountCents: 1000 },
    };

    await consume(event);

    expect(repo.upsert).not.toHaveBeenCalled();
  });
});
```

## 4) Job / Scheduler Test

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { CleanupService } from '../src/services/cleanup-service';
import { createCleanupJob } from '../src/jobs/cleanup';

describe('CleanupJob', () => {
  let service: CleanupService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = {
      purgeExpired: vi.fn(),
    } as unknown as CleanupService;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs purge on each interval tick', async () => {
    vi.mocked(service.purgeExpired).mockResolvedValue({ deleted: 5 });

    const stop = createCleanupJob(service, { intervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.purgeExpired).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.purgeExpired).toHaveBeenCalledTimes(2);

    stop();
  });

  it('continues running after a failed tick', async () => {
    vi.mocked(service.purgeExpired)
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockResolvedValueOnce({ deleted: 3 });

    const stop = createCleanupJob(service, { intervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(60_000); // first tick -- fails
    await vi.advanceTimersByTimeAsync(60_000); // second tick -- succeeds

    expect(service.purgeExpired).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stops cleanly when stop is called', async () => {
    const stop = createCleanupJob(service, { intervalMs: 60_000 });
    stop();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(service.purgeExpired).not.toHaveBeenCalled();
  });
});
```

## 5) Cache Adapter Test

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createCacheAdapter } from '../src/adapters/cache';

describe('CacheAdapter', () => {
  let backend: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
  let cache: ReturnType<typeof createCacheAdapter>;

  beforeEach(() => {
    backend = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    cache = createCacheAdapter(backend);
  });

  it('returns cached value on hit', async () => {
    backend.get.mockResolvedValue(JSON.stringify({ id: 'item_1' }));

    const result = await cache.get('item_1');

    expect(result).toEqual({ id: 'item_1' });
    expect(backend.get).toHaveBeenCalledWith('item_1');
  });

  it('returns null on miss', async () => {
    backend.get.mockResolvedValue(null);

    const result = await cache.get('item_missing');

    expect(result).toBeNull();
  });

  it('writes value and makes it retrievable', async () => {
    await cache.set('item_2', { id: 'item_2' });

    expect(backend.set).toHaveBeenCalledWith(
      'item_2',
      JSON.stringify({ id: 'item_2' }),
      expect.any(Object), // TTL options
    );
  });

  it('invalidates a cached key', async () => {
    await cache.invalidate('item_1');

    expect(backend.del).toHaveBeenCalledWith('item_1');
  });

  it('treats backend errors as cache miss', async () => {
    backend.get.mockRejectedValue(new Error('redis down'));

    const result = await cache.get('item_1');

    expect(result).toBeNull();
  });
});
```

## Verification Checklist

- Each skeleton covers success, expected-error, and unexpected-error paths.
- Infra is mocked; no real network or disk I/O in unit tests.
- Tests assert consumer-visible outputs and side effects, not internal implementation.
- Fake timers are restored in `afterEach` to avoid test pollution.
