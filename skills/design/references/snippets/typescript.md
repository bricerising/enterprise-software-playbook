# TypeScript Snippets (Design Patterns)

Small, idiomatic starting points for applying design patterns in TypeScript/Node. If you're following "Systemic TypeScript" guidelines, prefer closures over `class` (avoid `this` pitfalls; easier serialization), return-value error unions for expected failures (avoid `throw`), runtime validation when handling `unknown` at boundaries, explicit resource lifetimes (`start/stop/dispose`), and avoid import-time wiring in systemic code (wire in a composition root).

## Common helpers (throwless Result)

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
export const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
```

## Creational Patterns

### Factory Method (module factory seam)

- A low-friction "factory method" in TS is often just an exported constructor function that keeps module exports stable while allowing tests to inject config/dependencies.

- For systemic code, avoid import-time wiring; treat env/config as `unknown`, decode it once, then pass typed config into the factory.

```ts
type Transport = 'grpc' | 'http';

const isTransport = (value: string): value is Transport => value === 'grpc' || value === 'http';

type ClientConfig = {
  transport: Transport;
  url: string;
};

type ConfigError = { kind: 'invalid-transport'; value: string };

export const decodeClientConfig = (env: Record<string, string | undefined>): Result<ClientConfig, ConfigError> => {
  const transportRaw = env.GAME_TRANSPORT;
  if (transportRaw !== undefined && !isTransport(transportRaw)) {
    return err({ kind: 'invalid-transport', value: transportRaw });
  }

  return ok({
    transport: transportRaw ?? 'http',
    url: env.GAME_URL ?? 'http://localhost:3000',
  });
};

export const createClients = (config: ClientConfig) => ({
  gameClient: withRetry(createGameClient(config.transport, { url: config.url })),
});

// In your composition root:
// const config = decodeClientConfig(process.env);
// if (!config.ok) { /* log + exit */ }
// const { gameClient } = createClients(config.value);
```


If you need cross-cutting policies, attach them at the factory boundary (Decorator/Proxy):

```ts
type Player = { id: string; name: string };
type GetPlayerError =
  | { kind: 'network'; message: string }
  | { kind: 'bad-status'; status: number }
  | { kind: 'invalid-payload' };

type GameClient = { getPlayer: (id: string) => Promise<Result<Player, GetPlayerError>> };

export const withRetry = (inner: GameClient, maxAttempts = 3): GameClient => ({
  getPlayer: async (id) => {
    let last: Result<Player, GetPlayerError> | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await inner.getPlayer(id);
      last = result;
      if (result.ok) {
        return result;
      }
      if (result.error.kind !== 'network') {
        return result;
      }
    }
    return last ?? err({ kind: 'network', message: 'no-attempts' });
  },
});
```

### Factory Method (typed variant selection)

Use when caller depends on an interface, but the concrete implementation varies.

```ts
type Transport = 'grpc' | 'http';

type Player = { id: string; name: string };
type GetPlayerError =
  | { kind: 'network'; message: string }
  | { kind: 'bad-status'; status: number }
  | { kind: 'invalid-payload' };

export type GameClient = {
  getPlayer: (id: string) => Promise<Result<Player, GetPlayerError>>;
};

const isPlayer = (value: unknown): value is Player =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  'name' in value &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { name?: unknown }).name === 'string';

const grpcGameClient = (endpoint: string): GameClient => ({
  getPlayer: async (id) => ok({ id, name: `grpc-player (${endpoint})` }),
});

const httpGameClient = (baseUrl: string): GameClient => ({
  getPlayer: async (id) => {
    try {
      const response = await fetch(`${baseUrl}/players/${id}`);
      if (!response.ok) {
        return err({ kind: 'bad-status', status: response.status });
      }
      const json: unknown = await response.json();
      return isPlayer(json) ? ok(json) : err({ kind: 'invalid-payload' });
    } catch (error) {
      return err({
        kind: 'network',
        message: toError(error).message,
      });
    }
  },
});

// Strategy registry: avoids a growing switch as transports grow.
const creators = {
  grpc: (config: { url: string }) => grpcGameClient(config.url),
  http: (config: { url: string }) => httpGameClient(config.url),
} as const satisfies Record<Transport, (config: { url: string }) => GameClient>;

export const createGameClient = (transport: Transport, config: { url: string }): GameClient => creators[transport](config);
```

### Abstract Factory (family wiring)

Use when you must create multiple related components that must be compatible (a "family"), and you want to swap the family at configuration time.

```ts
export interface Queue {
  publish(topic: string, payload: unknown): Promise<void>;
}
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export interface CloudFactory {
  queue(): Queue;
  blobStore(): BlobStore;
}

type Provider = 'aws' | 'gcp';

const awsFactory = (_config: { region: string }): CloudFactory => ({
  queue: () => ({ publish: async () => {} }),
  blobStore: () => ({ put: async () => {} }),
});

const gcpFactory = (_config: { projectId: string }): CloudFactory => ({
  queue: () => ({ publish: async () => {} }),
  blobStore: () => ({ put: async () => {} }),
});

const factories = {
  aws: (config: { region?: string }) => awsFactory({ region: config.region ?? 'us-east-1' }),
  gcp: (config: { projectId?: string }) => gcpFactory({ projectId: config.projectId ?? 'local' }),
} as const satisfies Record<Provider, (config: { region?: string; projectId?: string }) => CloudFactory>;

export const createCloudFactory = (
  provider: Provider,
  config: { region?: string; projectId?: string },
): CloudFactory => factories[provider](config);
```

You can also wrap the factory (Proxy) to apply policies consistently to the whole family:

```ts
const withCloudLogging = (inner: CloudFactory, log: (line: string) => void): CloudFactory => ({
  queue: () => {
    const queueClient = inner.queue();
    return {
      publish: async (topic, payload) => {
        log(`queue.publish:${topic}`);
        return queueClient.publish(topic, payload);
      },
    };
  },
  blobStore: () => {
    const blobStoreClient = inner.blobStore();
    return {
      put: async (key, bytes) => {
        log(`blob.put:${key}`);
        return blobStoreClient.put(key, bytes);
      },
    };
  },
});
```

### Builder (validation + defaults at build time)

Use when construction has many optional parts and must enforce invariants.

```ts
type HttpRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
};

type BuildError =
  | { kind: 'missing-url' }
  | { kind: 'body-not-allowed'; method: 'GET' };

type HttpRequestDraft = {
  method: HttpRequest['method'];
  url: string | null;
  headers: Record<string, string>;
  body?: string;
};

const defaults: HttpRequestDraft = { method: 'GET', url: null, headers: {} };

export const httpRequestBuilder = (draft: HttpRequestDraft = defaults) => ({
  withMethod: (method: HttpRequest['method']) => httpRequestBuilder({ ...draft, method }),
  withUrl: (url: string) => httpRequestBuilder({ ...draft, url }),
  withHeader: (key: string, value: string) =>
    httpRequestBuilder({ ...draft, headers: { ...draft.headers, [key]: value } }),
  withBody: (body: string) => httpRequestBuilder({ ...draft, body }),
  build: (): Result<HttpRequest, BuildError> => {
    if (!draft.url) {
      return err({ kind: 'missing-url' });
    }
    if (draft.method === 'GET' && draft.body) {
      return err({ kind: 'body-not-allowed', method: 'GET' });
    }
    return ok({ method: draft.method, url: draft.url, headers: draft.headers, body: draft.body });
  },
});
```

### Prototype (clone with explicit semantics)

Use when cloning is cheaper/cleaner than reconstructing, and you need predictable copy behavior.

```ts
export type Prototype<T> = { clone: (overrides?: Partial<T>) => T };

type Job = {
  id: string;
  name: string;
  tags: string[];
};

export const jobPrototype = (job: Job): Prototype<Job> => ({
  clone: (overrides = {}) => ({
    // shallow copy primitives + arrays explicitly; define deep copy rules per field
    ...job,
    tags: [...job.tags],
    ...overrides,
  }),
});
```

Prototype is often paired with a small "registry factory":

```ts
type RegistryError = { kind: 'unknown-prototype'; key: string };

export const createPrototypeRegistry = <T,>() => {
  const prototypes = new Map<string, Prototype<T>>();
  return {
    register: (key: string, prototype: Prototype<T>) => {
      prototypes.set(key, prototype);
    },
    create: (key: string, overrides?: Partial<T>): Result<T, RegistryError> => {
      const proto = prototypes.get(key);
      return proto ? ok(proto.clone(overrides)) : err({ kind: 'unknown-prototype', key });
    },
  };
};
```

### Singleton (caution; prefer DI)

If you truly need a single shared instance, keep a creation seam so tests can override/reset it.

```ts
type Client = { ping: () => Promise<void> };

export const createSingleton = <T,>() => {
  let cached: T | null = null;
  return {
    get: (create: () => T): T => (cached ??= create()),
    resetForTest: () => {
      cached = null;
    },
  };
};

// Usage:
// const clientSingleton = createSingleton<Client>();
// const client = clientSingleton.get(makeClient);
```

## Structural Patterns

### Adapter (normalize `unknown` into domain types)

- When adapting third-party/legacy payloads, normalize `unknown` into your domain types with small helpers. Supporting multiple field names is common during migrations.

```ts
export const numberValue = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
};
```

- Keep adapters near IO (gRPC/HTTP/event consumers). Keep core domain code strongly typed and free of `unknown`.

### Adapter (wrap a third-party client behind your interface)

```ts
// Your domain interface (Target)
export interface PaymentsGateway {
  charge(amountCents: number, token: string): Promise<Result<{ id: string }, ChargeError>>;
}

type ChargeError =
  | { kind: 'network'; message: string }
  | { kind: 'unknown'; error: Error };

// Third-party SDK (Adaptee)
type StripeLike = {
  charges: { create: (request: { amount: number; source: string }) => Promise<{ id: string }> };
};

// Adapter
export const stripeGatewayAdapter = (stripe: StripeLike): PaymentsGateway => ({
  charge: async (amountCents, token) => {
    try {
      // translate domain inputs into SDK shape
      const response = await stripe.charges.create({ amount: amountCents, source: token });
      return ok(response);
    } catch (error) {
      return err({
        kind: 'network',
        message: toError(error).message,
      });
    }
  },
});

// Proxy/Decorator: attach policy at the boundary without changing the PaymentsGateway interface.
export const withRetryGateway = (inner: PaymentsGateway, maxAttempts = 3): PaymentsGateway => ({
  charge: async (amountCents, token) => {
    let last: Result<{ id: string }, ChargeError> | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await inner.charge(amountCents, token);
      last = result;
      if (result.ok) {
        return result;
      }
      if (result.error.kind !== 'network') {
        return result;
      }
    }
    return last ?? err({ kind: 'unknown', error: new Error('no-attempts') });
  },
});

// Factory Method: produce the final gateway (adapter + policies) in one place.
export const createPaymentsGateway = (stripe: StripeLike): PaymentsGateway =>
  withRetryGateway(stripeGatewayAdapter(stripe));
```

### Bridge (abstraction + implementor)

Two axes of variation: a stable abstraction delegates to an interchangeable implementor.

```ts
export interface LogSink {
  write(line: string): void;
}

export const consoleSink = (): LogSink => ({ write: (line) => console.log(line) });

export const bufferedSink = (buffer: string[] = []): LogSink => ({
  write: (line) => {
    buffer.push(line);
  },
});

// Abstraction (closure over class)
export const createLogger = (sink: LogSink) => ({
  info: (message: string) => sink.write(`INFO ${message}`),
});

// Decorator: add formatting/policies without changing the LogSink interface.
export const withPrefix = (prefix: string, inner: LogSink): LogSink => ({
  write: (line) => inner.write(`${prefix}${line}`),
});
```

### Composite (tree of components)

```ts
export interface Component {
  cost(): number;
}

export const item = (price: number): Component => ({ cost: () => price });
export const bundle = (children: readonly Component[]): Component => ({
  cost: () => children.reduce((sum, c) => sum + c.cost(), 0),
});
```

### Decorator (wrap an interface to add behavior)

```ts
export type User = { id: string; name: string };

type UserRepoError = { kind: 'unknown'; error: Error };
export type UserRepoResult = Result<User | null, UserRepoError>;

export interface UserRepo {
  getById(id: string): Promise<UserRepoResult>;
}

export const withTracingUserRepo = (inner: UserRepo, log: (line: string) => void): UserRepo => ({
  getById: async (id) => {
    const start = Date.now();
    try {
      return await inner.getById(id);
    } finally {
      log(`UserRepo.getById(${id}) ${Date.now() - start}ms`);
    }
  },
});

export const withCachingUserRepo = (inner: UserRepo): UserRepo => {
  const cache = new Map<string, Promise<UserRepoResult>>();
  return {
    getById: async (id) => {
      const existing = cache.get(id);
      if (existing) {
        return existing;
      }

      const value = inner
        .getById(id)
        .catch((error) => err({ kind: 'unknown', error: toError(error) }))
        .then((result) => {
          if (!result.ok) {
            cache.delete(id);
          }
          return result;
        });

      cache.set(id, value);
      return value;
    },
  };
};

// Factory Method: assemble a decorator stack at the boundary.
export const createUserRepo = (base: UserRepo, dependencies: { log: (line: string) => void }): UserRepo =>
  withCachingUserRepo(withTracingUserRepo(base, dependencies.log));
```

### Facade (hide multi-client orchestration)

```ts
type CheckoutError = { kind: 'unknown'; error: Error };

type Inventory = { reserve: (sku: string) => Promise<void> };
type Payments = { charge: (amountCents: number) => Promise<void> };
type Shipping = { createLabel: (sku: string) => Promise<string> };

export const createCheckoutFacade = (services: {
  inventory: Inventory;
  payments: Payments;
  shipping: Shipping;
}) => ({
  checkout: async (sku: string, amountCents: number): Promise<Result<string, CheckoutError>> => {
    try {
      await services.inventory.reserve(sku);
      await services.payments.charge(amountCents);
      const label = await services.shipping.createLabel(sku);
      return ok(label);
    } catch (error) {
      return err({ kind: 'unknown', error: toError(error) });
    }
  },
});
```

### Flyweight (share intrinsic state via a factory)

```ts
type Glyph = { char: string; render: (x: number, y: number) => void };

export const createGlyphFactory = () => {
  const cache = new Map<string, Glyph>();
  return {
    get: (char: string): Glyph => {
      const existing = cache.get(char);
      if (existing) {
        return existing;
      }
      const glyph: Glyph = { char, render: () => {} };
      cache.set(char, glyph);
      return glyph;
    },
  };
};

// extrinsic state (x,y) supplied at call time:
// glyphFactory.get('A').render(10, 20)
```

### Proxy (lazy init + policy)

```ts
type BlobStoreError = { kind: 'unknown'; error: Error };
type BlobStoreResult = Result<Uint8Array | null, BlobStoreError>;

export interface BlobStore {
  get(key: string): Promise<BlobStoreResult>;
}

export const lazyBlobStore = (create: () => BlobStore): BlobStore => {
  let real: BlobStore | null = null;
  return {
    get: async (key) => {
      try {
        real ??= create();
      } catch (error) {
        return err({ kind: 'unknown', error: toError(error) });
      }

      return real.get(key).catch((error) => err({ kind: 'unknown', error: toError(error) }));
    },
  };
};

// Proxy: cache results (and de-duplicate concurrent requests).
export const cachedBlobStore = (inner: BlobStore): BlobStore => {
  const cache = new Map<string, Promise<BlobStoreResult>>();
  return {
    get: async (key) => {
      const existing = cache.get(key);
      if (existing) {
        return existing;
      }

      const value = inner
        .get(key)
        .catch((error) => err({ kind: 'unknown', error: toError(error) }))
        .then((result) => {
          if (!result.ok) {
            cache.delete(key);
          }
          return result;
        });

      cache.set(key, value);
      return value;
    },
  };
};

// Factory Method: compose proxies in one place (composition root).
export const createBlobStore = (createReal: () => BlobStore): BlobStore =>
  cachedBlobStore(lazyBlobStore(createReal));
```

## Behavioral Patterns

### Strategy (registry + factory + decorator)

```ts
type Kind = 'A' | 'B';

export type Strategy = (value: number) => number;

const base = {
  A: (value) => value + 1,
  B: (value) => value - 1,
} as const satisfies Record<Kind, Strategy>;

// Decorator: wrap a strategy with cross-cutting behavior.
export const withLogging = (name: string, inner: Strategy, log: (line: string) => void): Strategy =>
  (value) => {
    log(`${name}(${value})`);
    return inner(value);
  };

// Factory Method: choose and wire a strategy (often at the composition root).
export const createStrategy = (kind: Kind, dependencies: { log: (line: string) => void }): Strategy =>
  withLogging(kind, base[kind], dependencies.log);

// Avoid `value in base` here: it also matches inherited keys like 'toString'.
export const isKind = (value: string): value is Kind => Object.prototype.hasOwnProperty.call(base, value);
```

### Chain of Responsibility (pipeline + adapter + decorator)

```ts
export type Request = { type: string; payload: unknown };

export type ChainResult<T> =
  | { handled: true; value: T }
  | { handled: false };

export type AsyncHandler<T> = (request: Request) => Promise<ChainResult<T>>;
export type SyncHandler<T> = (request: Request) => ChainResult<T>;

// Adapter: normalize sync handlers into the async pipeline shape.
export const adaptSync = <T>(handler: SyncHandler<T>): AsyncHandler<T> => async (request) => handler(request);

// Decorator: add a policy without changing handler signatures.
export const withTracing = <T>(
  name: string,
  inner: AsyncHandler<T>,
  log: (line: string) => void,
): AsyncHandler<T> => {
  return async (request) => {
    log(`-> ${name}`);
    const result = await inner(request);
    log(`<- ${name}`);
    return result;
  };
};

// Compose a chain into a single handler.
export const composeChain = <T>(handlers: readonly AsyncHandler<T>[]): AsyncHandler<T> => async (request) => {
  for (const handler of handlers) {
    const result = await handler(request);
    if (result.handled) {
      return result;
    }
  }
  return { handled: false };
};

// Example: validate boundary data (`unknown`) and return a throwless Result.
type CreateUserOk = { kind: 'created'; id: string };
type CreateUserError = { kind: 'invalid-payload' };

const isCreateUserPayload = (value: unknown): value is { id: string } =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';

export const createUserHandler: AsyncHandler<Result<CreateUserOk, CreateUserError>> = async (request) => {
  if (request.type !== 'createUser') {
    return { handled: false };
  }

  if (!isCreateUserPayload(request.payload)) {
    return { handled: true, value: err({ kind: 'invalid-payload' }) };
  }

  return { handled: true, value: ok({ kind: 'created', id: request.payload.id }) };
};
```

### Command (factory + decorator + queue)

```ts
export type CommandError =
  | { kind: 'retryable'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; error: Error };

export type Command = {
  execute: () => Promise<Result<void, CommandError>>;
  undo?: () => Promise<Result<void, CommandError>>;
};

// Decorator/Proxy: add retry policy without changing the command interface.
export const withRetry = (inner: Command, maxAttempts = 3): Command => {
  const undo = inner.undo;
  return {
    execute: async () => {
      let last: Result<void, CommandError> | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await inner.execute().catch((error) => {
          return err({ kind: 'unknown', error: toError(error) });
        });
        last = result;
        if (result.ok) {
          return result;
        }
        if (result.error.kind !== 'retryable') {
          return result;
        }
      }
      return last ?? err({ kind: 'retryable', message: 'no-attempts' });
    },
    undo: undo ? async () => undo() : undefined,
  };
};

// Factory Method: build typed commands from a kind + dependencies.
type CommandKind = 'increment' | 'decrement';
type Counter = { value: number };

const commandFactories = {
  increment: (counter: Counter): Command => ({
    execute: async () => {
      counter.value += 1;
      return ok(undefined);
    },
    undo: async () => {
      counter.value -= 1;
      return ok(undefined);
    },
  }),
  decrement: (counter: Counter): Command => ({
    execute: async () => {
      counter.value -= 1;
      return ok(undefined);
    },
    undo: async () => {
      counter.value += 1;
      return ok(undefined);
    },
  }),
} as const satisfies Record<CommandKind, (counter: Counter) => Command>;

export const createCommand = (kind: CommandKind, counter: Counter): Command => commandFactories[kind](counter);

// Closure over class: a simple in-memory command queue with undo.
export const createCommandQueue = () => {
  const history: Command[] = [];

  const run = async (command: Command) => {
    const result = await command.execute();
    if (result.ok) {
      history.push(command);
    }
    return result;
  };

  const undoLast = async () => {
    const cmd = history.pop();
    if (!cmd?.undo) {
      return ok(undefined);
    }
    return cmd.undo();
  };

  return { run, undoLast };
};
```

### Observer (interface + decorator)

```ts
type Events = {
  userCreated: { id: string };
  userDeleted: { id: string };
};

type Unsubscribe = () => void;

export interface EventBus<E extends Record<string, unknown>> {
  on<K extends keyof E>(event: K, listener: (payload: E[K]) => void): Unsubscribe;
  emit<K extends keyof E>(event: K, payload: E[K]): void;
}

export const createEmitter = <E extends Record<string, unknown>>(): EventBus<E> => {
  const listenersByEvent: Partial<{ [K in keyof E]: Set<(payload: E[K]) => void> }> = {};

  return {
    on: (event, listener) => {
      const listeners = listenersByEvent[event] ?? new Set<(payload: E[typeof event]) => void>();
      listeners.add(listener);
      listenersByEvent[event] = listeners;
      return () => listeners.delete(listener);
    },
    emit: (event, payload) => {
      listenersByEvent[event]?.forEach((listener) => listener(payload));
    },
  };
};

// Decorator: add logging or filtering without changing the EventBus interface.
export const withEventLogging = <E extends Record<string, unknown>>(
  inner: EventBus<E>,
  log: (line: string) => void,
): EventBus<E> => ({
  on: (event, listener) => inner.on(event, listener),
  emit: (event, payload) => {
    log(String(event));
    inner.emit(event, payload);
  },
});

// Usage:
// const bus = createEmitter<Events>();
// bus.on('userCreated', (e) => console.log(e.id));
// bus.emit('userCreated', { id: '123' });
```

### State (discriminated union + transition function)

```ts
export type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

export type Action =
  | { type: 'load' }
  | { type: 'ok' }
  | { type: 'fail'; message: string };

export const transition = (state: State, action: Action): State => {
  switch (state.kind) {
    case 'idle':
      if (action.type === 'load') {
        return { kind: 'loading' };
      }
      return state;
    case 'loading':
      if (action.type === 'ok') {
        return { kind: 'idle' };
      }
      if (action.type === 'fail') {
        return { kind: 'error', message: action.message };
      }
      return state;
    case 'error':
      if (action.type === 'load') {
        return { kind: 'loading' };
      }
      return state;
  }
};
```

### State (state objects as flyweights)

When states are immutable/stateless, you can reuse them across contexts (Flyweight-style).

```ts
export type LightState = { kind: 'red' | 'green' | 'yellow'; next: () => LightState };

export const Red: LightState = { kind: 'red', next: () => Green };
export const Green: LightState = { kind: 'green', next: () => Yellow };
export const Yellow: LightState = { kind: 'yellow', next: () => Red };

export const createTrafficLight = (initial: LightState = Red) => {
  let state = initial;
  return {
    tick: () => {
      state = state.next();
    },
    current: () => state.kind,
  };
};
```

### Iterator (generator-based traversal)

```ts
type Node = { value: number; children?: Node[] };

export function* dfs(node: Node): Generator<Node> {
  yield node;
  for (const child of node.children ?? []) {
    yield* dfs(child);
  }
}

// Usage:
// for (const n of dfs(root)) console.log(n.value);
```

### Mediator (central coordinator)

```ts
type CloseReason = 'backdrop' | 'escape' | 'button' | 'program';

type ModalEvent =
  | { type: 'request.open' }
  | { type: 'request.close'; reason: CloseReason }
  | { type: 'backdrop.click' }
  | { type: 'key.escape' };

export interface ModalMediator {
  notify(event: ModalEvent): void;
}

type Telemetry = { track: (event: string, props?: Record<string, unknown>) => void };
type ScrollLock = { lock: () => void; unlock: () => void };

// Colleague: backdrop doesn't close the modal directly. It notifies the mediator.
export type Backdrop = {
  setMediator(mediator: ModalMediator): void;
  show(): void;
  hide(): void;
  click(): void;
};

export const createBackdrop = (view: { show: () => void; hide: () => void }): Backdrop => {
  let mediator: ModalMediator | null = null;
  return {
    setMediator: (nextMediator) => {
      mediator = nextMediator;
    },
    show: view.show,
    hide: view.hide,
    click: () => mediator?.notify({ type: 'backdrop.click' }),
  };
};

// Colleague: modal view delegates close-button behavior to the mediator.
export type Modal = {
  setMediator(mediator: ModalMediator): void;
  show(): void;
  hide(): void;
  focusFirst(): void;
  closeButtonClick(): void;
};

export const createModal = (view: {
  show: () => void;
  hide: () => void;
  focusFirst: () => void;
}): Modal => {
  let mediator: ModalMediator | null = null;
  return {
    setMediator: (nextMediator) => {
      mediator = nextMediator;
    },
    show: view.show,
    hide: view.hide,
    focusFirst: view.focusFirst,
    closeButtonClick: () => mediator?.notify({ type: 'request.close', reason: 'button' }),
  };
};

type KeyEvent = { key: string };
type KeyTarget = {
  addEventListener: (type: 'keydown', listener: (e: KeyEvent) => void) => void;
  removeEventListener: (type: 'keydown', listener: (e: KeyEvent) => void) => void;
};

// Colleague: escape-key handling routes through the mediator (not directly to the modal).
export type EscapeKey = {
  setMediator(mediator: ModalMediator): void;
  enable(): void;
  disable(): void;
};

export const createEscapeKey = (target: KeyTarget): EscapeKey => {
  let mediator: ModalMediator | null = null;
  const onKeyDown = (e: KeyEvent) => {
    if (e.key === 'Escape') {
      mediator?.notify({ type: 'key.escape' });
    }
  };
  return {
    setMediator: (nextMediator) => {
      mediator = nextMediator;
    },
    enable: () => target.addEventListener('keydown', onKeyDown),
    disable: () => target.removeEventListener('keydown', onKeyDown),
  };
};

// Mediator: owns all coordination rules (open/close, scroll lock, telemetry, etc).
export const createModalMediator = (deps: {
  modal: Modal;
  backdrop: Backdrop;
  escapeKey: EscapeKey;
  scrollLock: ScrollLock;
  telemetry: Telemetry;
}): ModalMediator => {
  let isOpen = false;

  const open = () => {
    if (isOpen) {
      return;
    }
    isOpen = true;
    deps.scrollLock.lock();
    deps.backdrop.show();
    deps.modal.show();
    deps.modal.focusFirst();
    deps.escapeKey.enable();
    deps.telemetry.track('modal_open');
  };

  const close = (reason: CloseReason) => {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    deps.escapeKey.disable();
    deps.modal.hide();
    deps.backdrop.hide();
    deps.scrollLock.unlock();
    deps.telemetry.track('modal_close', { reason });
  };

  return {
    notify: (event) => {
      switch (event.type) {
        case 'request.open':
          open();
          return;
        case 'request.close':
          close(event.reason);
          return;
        case 'backdrop.click':
          close('backdrop');
          return;
        case 'key.escape':
          close('escape');
          return;
      }
    },
  };
};

// Wiring (composition root):
// const backdrop = createBackdrop(backdropView);
// const modal = createModal(modalView);
// const escapeKey = createEscapeKey(window);
// const mediator = createModalMediator({ modal, backdrop, escapeKey, scrollLock, telemetry });
// backdrop.setMediator(mediator); modal.setMediator(mediator); escapeKey.setMediator(mediator);
```

### Memento (snapshot/restore)

```ts
declare const editorMementoBrand: unique symbol;
export type EditorMemento = { readonly [editorMementoBrand]: true };

type EditorSnapshot = {
  text: string;
  selection: { start: number; end: number };
};

const cloneSnapshot = (s: EditorSnapshot): EditorSnapshot => ({
  text: s.text,
  selection: { ...s.selection },
});

// Originator: creates and restores opaque mementos (caretaker cannot inspect).
const snapshots = new WeakMap<EditorMemento, EditorSnapshot>();

export const createEditor = (initialText: string) => {
  let state: EditorSnapshot = { text: initialText, selection: { start: 0, end: 0 } };

  const createMemento = (): EditorMemento => {
    const memento = { [editorMementoBrand]: true } as EditorMemento;
    snapshots.set(memento, cloneSnapshot(state));
    return memento;
  };

  const restore = (memento: EditorMemento) => {
    const snapshot = snapshots.get(memento);
    if (!snapshot) {
      return;
    }
    state = cloneSnapshot(snapshot);
  };

  return {
    getText: () => state.text,
    getSelection: () => ({ ...state.selection }),
    setText: (text: string) => {
      state = { ...state, text };
    },
    setSelection: (start: number, end: number) => {
      state = { ...state, selection: { start, end } };
    },
    createMemento,
    restore,
  };
};

// Caretaker: manages undo/redo stacks without inspecting the snapshot.
export const createHistory = <M>() => {
  const past: M[] = [];
  const future: M[] = [];

  const push = (snapshot: M) => {
    past.push(snapshot);
    future.length = 0;
  };

  const undo = (current: M): M | null => {
    const prev = past.pop() ?? null;
    if (!prev) {
      return null;
    }
    future.unshift(current);
    return prev;
  };

  const redo = (current: M): M | null => {
    const next = future.shift() ?? null;
    if (!next) {
      return null;
    }
    past.push(current);
    return next;
  };

  return { push, undo, redo };
};
```

### Template Method (template function + hooks)

```ts
type ImportError =
  | { kind: 'read-failed'; message: string }
  | { kind: 'invalid-json'; message: string }
  | { kind: 'invalid-csv'; message: string }
  | { kind: 'invalid-user'; index: number }
  | { kind: 'duplicate-user-id'; id: string }
  | { kind: 'write-failed'; message: string };

type User = { id: string; aliases: string[] };

const isUser = (value: unknown): value is User =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  Array.isArray((value as { aliases?: unknown }).aliases) &&
  (value as { aliases: unknown[] }).aliases.every((a) => typeof a === 'string');

type ImportTemplate<T> = {
  read: (input: string) => Promise<Result<string, ImportError>>;
  parse: (raw: string) => Result<T, ImportError>;
  validate?: (parsed: T) => Result<T, ImportError>;
  write: (value: T) => Promise<Result<void, ImportError>>;
};

const safeAsync = async <T>(
  operation: () => Promise<Result<T, ImportError>>,
  onThrow: (e: Error) => ImportError,
): Promise<Result<T, ImportError>> =>
  operation().catch((error) => err(onThrow(toError(error))));

// Template Method: fixed algorithm skeleton + overridable steps/hooks.
export const runImport = async <T>(
  template: ImportTemplate<T>,
  input: string,
): Promise<Result<void, ImportError>> => {
  const raw = await safeAsync(() => template.read(input), (error) => {
    return { kind: 'read-failed', message: error.message };
  });
  if (!raw.ok) {
    return raw;
  }

  const parsed = template.parse(raw.value);
  if (!parsed.ok) {
    return parsed;
  }

  const validate = template.validate ?? ((value: T) => ok(value));
  const validated = validate(parsed.value);
  if (!validated.ok) {
    return validated;
  }

  const written = await safeAsync(() => template.write(validated.value), (error) => {
    return { kind: 'write-failed', message: error.message };
  });
  if (!written.ok) {
    return written;
  }

  return ok(undefined);
};

type Format = 'json' | 'csv';
type Importer = { run: (input: string) => Promise<Result<void, ImportError>> };

type ImporterDependencies = {
  readText: (path: string) => Promise<Result<string, ImportError>>;
  writeUsers: (users: User[]) => Promise<Result<void, ImportError>>;
};

const validateUsers = (users: User[]): Result<User[], ImportError> => {
  const seen = new Set<string>();
  for (const user of users) {
    if (seen.has(user.id)) {
      return err({ kind: 'duplicate-user-id', id: user.id });
    }
    seen.add(user.id);
  }
  return ok(users);
};

const parseJsonUsers = (raw: string): Result<User[], ImportError> => {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    return err({ kind: 'invalid-json', message: toError(error).message });
  }
  if (!Array.isArray(json)) {
    return err({ kind: 'invalid-user', index: 0 });
  }
  for (let i = 0; i < json.length; i++) {
    if (!isUser(json[i])) {
      return err({ kind: 'invalid-user', index: i });
    }
  }
  return ok(json);
};

const parseCsvUsers = (raw: string): Result<User[], ImportError> => {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  // Format: id,alias1|alias2|alias3
  const users: User[] = [];
  for (let line = 0; line < lines.length; line++) {
    const parts = lines[line].split(',');
    const id = (parts[0] ?? '').trim();
    if (!id) {
      return err({ kind: 'invalid-csv', message: `missing id on line ${line + 1}` });
    }
    const aliasesRaw = (parts[1] ?? '').trim();
    const aliases = aliasesRaw ? aliasesRaw.split('|').map((a) => a.trim()).filter(Boolean) : [];
    users.push({ id, aliases });
  }
  return ok(users);
};

const createJsonUsersImporter = (deps: ImporterDependencies): Importer => {
  const template: ImportTemplate<User[]> = {
    read: deps.readText,
    parse: parseJsonUsers,
    validate: validateUsers,
    write: deps.writeUsers,
  };
  return { run: (path) => runImport(template, path) };
};

const createCsvUsersImporter = (deps: ImporterDependencies): Importer => {
  const template: ImportTemplate<User[]> = {
    read: deps.readText,
    parse: parseCsvUsers,
    validate: validateUsers,
    write: deps.writeUsers,
  };
  return { run: (path) => runImport(template, path) };
};

// Factory Method: pick a concrete implementation without changing callers of runImport.
const importerFactories = {
  json: createJsonUsersImporter,
  csv: createCsvUsersImporter,
} as const satisfies Record<Format, (deps: ImporterDependencies) => Importer>;

export const createImporter = (format: Format, deps: ImporterDependencies): Importer => importerFactories[format](deps);
```

### Visitor (tagged union visitor)

```ts
type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'add'; left: Expr; right: Expr };

type ExprVisitor<R> = {
  num: (expr: Extract<Expr, { kind: 'num' }>) => R;
  add: (expr: Extract<Expr, { kind: 'add' }>) => R;
};

export const visitExpr = <R>(expr: Expr, visitor: ExprVisitor<R>): R => {
  switch (expr.kind) {
    case 'num':
      return visitor.num(expr);
    case 'add':
      return visitor.add(expr);
  }
};

export const evalVisitor = {
  num: (e) => e.value,
  add: (e) => visitExpr(e.left, evalVisitor) + visitExpr(e.right, evalVisitor),
} satisfies ExprVisitor<number>;

export const printVisitor = {
  num: (e) => String(e.value),
  add: (e) => `(${visitExpr(e.left, printVisitor)} + ${visitExpr(e.right, printVisitor)})`,
} satisfies ExprVisitor<string>;
```
