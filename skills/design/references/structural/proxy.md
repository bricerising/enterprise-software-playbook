# Proxy

## Intent

Provide a stand-in for another object to control access, add indirection, or attach policies (lazy loading, caching, auth, throttling, remote access).

## Use When

- You need **lazy initialization** of expensive objects.
- You want **caching** or **memoization** transparently behind an interface.
- You must enforce **access control**, **rate limits**, **logging**, or **retries** at a boundary.
- The “real subject” lives elsewhere (remote service) but you want a local-looking API.

## Prefer Something Else When

- You’re adding optional features rather than access policy (Decorator).
- You’re simplifying a subsystem rather than standing in for one object (Facade).

## Minimal Structure

- `Subject` interface
- `RealSubject` implements `Subject`
- `Proxy` implements `Subject`, holds or creates `RealSubject`, intercepts calls

## Implementation Steps

1. Define a stable `Subject` interface.
2. Implement the proxy to:
   - create the real subject lazily or inject it
   - apply one clear policy (cache/auth/limits/logging)
   - delegate calls and preserve error semantics
3. Make policy semantics explicit: cache key, invalidation, concurrency, timeouts, and lifetime forwarding (`close`/`dispose`).

## Pitfalls

- **Hidden latency/IO**: a proxy may look cheap but perform network/IO; document and test this.
- **Caching correctness**: invalidation rules matter more than the cache implementation.
- **Concurrency**: avoid double-initialization and race conditions in lazy proxies.

## Testing Checklist

- Proxy behavior matches subject contract for success and failure cases.
- Policy tests: cache hit/miss, auth deny/allow, lazy init once, throttling.
- Concurrency tests if the proxy is shared across threads/tasks.

