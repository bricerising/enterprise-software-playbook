# TypeScript Security Snippets

Use these as starter shapes, not drop-in security guarantees.

## 1) Decode External Input At The Boundary

```ts
import { z } from 'zod';

const CreateOrderSchema = z.object({
  accountId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: z.enum(['USD', 'EUR']),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export function decodeCreateOrder(input: unknown): CreateOrderInput {
  return CreateOrderSchema.parse(input);
}
```

## 2) Parameterized SQL Query

```ts
import type { Pool } from 'pg';

export async function loadOrder(pool: Pool, orderId: string, tenantId: string) {
  const result = await pool.query(
    `SELECT id, tenant_id, status, total_cents
     FROM orders
     WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId],
  );

  return result.rows[0] ?? null;
}
```

## 3) SSRF Host Allowlist

```ts
const ALLOWED_HOSTS = new Set(['api.internal.example.com', 'assets.example.com']);

export function assertAllowedOutboundUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('Outbound URL is not allowed');
  }
  return url;
}
```

## Verification Checklist

- Validation errors return safe, structured client-facing messages.
- Query surfaces tenant-scoped results only.
- Outbound URL checks run before network calls.
