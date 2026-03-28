# React Snippets (Design Patterns)

These examples assume a React environment (`react` installed, JSX enabled, `React` in scope). They intentionally cover only cases where **React built-ins** (Context, hooks like `useReducer` / `useSyncExternalStore`, `memo`, `lazy`, `Suspense`, `cloneElement`) change the most idiomatic implementation compared to plain TypeScript. For language-only examples, see `references/snippets/typescript.md`.

## Creational Patterns

### Omitted (not React-specific)

- Simple "factory method" component selection (switching between implementations) is usually just TypeScript control flow; see `references/snippets/typescript.md`.

### Contents

- Abstract Factory (design system via context)
- Builder (normalize/validate config)
- "Singleton" (app-wide service via context)

### Abstract Factory (theme/design-system factory via context)

Use when you need a compatible *family* of components (Button, Link, Modal) that must change together (white-labeling, multi-brand).

```tsx
import * as React from 'react';

type DesignSystem = {
  Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>>;
  Link: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>>;
};

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E,>(error: E): Result<never, E> => ({ ok: false, error });

const DesignSystemContext = React.createContext<DesignSystem | null>(null);

type UseDesignSystemError = { kind: 'missing-design-system-provider' };

export const useDesignSystem = (): Result<DesignSystem, UseDesignSystemError> => {
  const value = React.useContext(DesignSystemContext);
  return value ? ok(value) : err({ kind: 'missing-design-system-provider' });
};

export const DesignSystemProvider = ({
  create,
  deps,
  children,
}: {
  create: () => DesignSystem;
  deps: React.DependencyList;
  children: React.ReactNode;
}) => {
  // Factory Method + memoization: build the family once per dependency set.
  const value = React.useMemo(create, deps);
  return <DesignSystemContext.Provider value={value}>{children}</DesignSystemContext.Provider>;
};
```

### Builder (reduce prop explosion with a typed config object)

Use when configuration has many optional parts and must be built stepwise with validation/defaults.

```tsx
import * as React from 'react';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E,>(error: E): Result<never, E> => ({ ok: false, error });

type QueryConfig = {
  page: number;
  pageSize: number;
  sort?: 'name' | 'createdAt';
};

type BuildError =
  | { kind: 'invalid-page'; page: number }
  | { kind: 'invalid-page-size'; pageSize: number };

type Draft = {
  page: number | null;
  pageSize: number | null;
  sort?: QueryConfig['sort'];
};

const defaults: Draft = { page: null, pageSize: null };

// Builder: chainable steps + one build() that enforces invariants.
const queryBuilder = (draft: Draft = defaults) => ({
  withPage: (page: number) => queryBuilder({ ...draft, page }),
  withPageSize: (pageSize: number) => queryBuilder({ ...draft, pageSize }),
  withSort: (sort: QueryConfig['sort'] | undefined) => queryBuilder({ ...draft, sort }),
  build: (): Result<QueryConfig, BuildError> => {
    const page = draft.page ?? 1;
    const pageSize = draft.pageSize ?? 25;

    if (!Number.isInteger(page) || page < 1) {
      return err({ kind: 'invalid-page', page });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return err({ kind: 'invalid-page-size', pageSize });
    }

    return ok({ page, pageSize, sort: draft.sort });
  },
});

const buildQuery = (raw: Partial<QueryConfig>) =>
  queryBuilder()
    .withPage(raw.page ?? 1)
    .withPageSize(raw.pageSize ?? 25)
    .withSort(raw.sort)
    .build();

export const Results = ({ rawConfig }: { rawConfig: Partial<QueryConfig> }) => {
  const result = React.useMemo(() => buildQuery(rawConfig), [rawConfig]);
  if (!result.ok) {
    return <div>Invalid config: {result.error.kind}</div>;
  }
  return <div>page={result.value.page}</div>;
};
```

### "Singleton" (app-wide service via Context)

Use when you need a single shared instance *for the React tree* (e.g., API client). Prefer Context + `useMemo` over module globals so tests and SSR are cleaner.

```tsx
import * as React from 'react';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E,>(error: E): Result<never, E> => ({ ok: false, error });
const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

type ApiError =
  | { kind: 'aborted' }
  | { kind: 'network'; message: string }
  | { kind: 'bad-status'; status: number }
  | { kind: 'invalid-json'; message: string };

type ApiClient = {
  getJson: (path: string, options?: { signal?: AbortSignal }) => Promise<Result<unknown, ApiError>>;
};

const ApiClientContext = React.createContext<ApiClient | null>(null);

export const ApiClientProvider = ({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children: React.ReactNode;
}) => {
  const client = React.useMemo<ApiClient>(() => {
    return {
      getJson: async (path, options) => {
        try {
          const res = await fetch(`${baseUrl}${path}`, { signal: options?.signal });
          if (!res.ok) {
            return err({ kind: 'bad-status', status: res.status });
          }

          try {
            const json: unknown = await res.json();
            return ok(json);
          } catch (error) {
            return err({ kind: 'invalid-json', message: toError(error).message });
          }
        } catch (error) {
          const e = toError(error);
          if (e.name === 'AbortError') {
            return err({ kind: 'aborted' });
          }
          return err({ kind: 'network', message: e.message });
        }
      },
    };
  }, [baseUrl]);

  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
};

type UseApiClientError = { kind: 'missing-api-client-provider' };

export const useApiClient = (): Result<ApiClient, UseApiClientError> => {
  const value = React.useContext(ApiClientContext);
  return value ? ok(value) : err({ kind: 'missing-api-client-provider' });
};
```

## Structural Patterns

### Omitted (not React-specific)

- **Composite** recursion over a tree and **Adapter** mapping between data shapes are usually plain TypeScript; see `references/snippets/typescript.md`.

### Contents

- Decorator (cloneElement)
- Facade (custom hook)
- Proxy (lazy + gating)
- Bridge (context-based implementation)

### Decorator (wrap behavior with React built-ins)

Wrap a component to add behavior (concern stays outside the core component). In React this often looks like "decorate children" with `React.cloneElement`.

```tsx
import * as React from 'react';

export const WithTracking = ({
  eventName,
  children,
}: {
  eventName: string;
  children: React.ReactElement<{ onClick?: React.MouseEventHandler }>;
}) => {
  const child = React.Children.only(children);
  const wrappedOnClick = React.useCallback<React.MouseEventHandler>(
    (e) => {
      console.log('track', eventName);
      child.props.onClick?.(e);
    },
    [eventName, child.props.onClick],
  );

  return React.cloneElement(child, { onClick: wrappedOnClick });
};
```

### Facade (custom hook hides a subsystem)

Hide data-fetching + caching + transformation behind a single hook.

```tsx
import * as React from 'react';

type User = { id: string; name: string };

const isUser = (value: unknown): value is User => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string';
};

type UserProfileError =
  | { kind: 'bad-status'; status: number }
  | { kind: 'invalid-payload' }
  | { kind: 'network'; message: string };

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

export const useUserProfile = (userId: string) => {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<UserProfileError | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/users/${userId}`, { signal: controller.signal });
        if (!res.ok) {
          setUser(null);
          setError({ kind: 'bad-status', status: res.status });
          return;
        }

        const json: unknown = await res.json();
        if (!isUser(json)) {
          setUser(null);
          setError({ kind: 'invalid-payload' });
          return;
        }

        setUser(json);
      } catch (error) {
        const caughtError = toError(error);
        if (caughtError.name === 'AbortError') {
          return;
        }
        setUser(null);
        setError({ kind: 'network', message: caughtError.message });
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [userId]);

  return { user, loading, error };
};
```

### Proxy (lazy loading / gated access / memoization)

Use a component as a stand-in that controls access or defers loading.

```tsx
import * as React from 'react';

const SettingsPage = React.lazy(() => import('./SettingsPage'));

type ViewAccess =
  | { kind: 'allowed' }
  | { kind: 'denied'; reason?: string };

export const SettingsRoute = ({ access }: { access: ViewAccess }) => {
  if (access.kind === 'denied') {
    return <div>Not authorized{access.reason ? `: ${access.reason}` : null}</div>;
  }
  return (
    <React.Suspense fallback={<div>Loading…</div>}>
      <SettingsPage />
    </React.Suspense>
  );
};
```

`React.memo` acts like a caching proxy for rendering:

```tsx
import * as React from 'react';

export const memoize = <P,>(Component: React.FC<P>) => React.memo(Component);
```

### Bridge (abstraction decoupled from implementation via injected "renderer")

Two axes: the stable "toast API" your app depends on (abstraction) vs how toasts are actually rendered/delivered (implementor). Context selects the implementor; callers only use the abstraction.

```tsx
import * as React from 'react';

type ToastKind = 'info' | 'success' | 'error';

type ToastItem = {
  id: string;
  kind: ToastKind;
  message: string;
  durationMs: number;
};

// Implementor: low-level toast delivery (UI, native bridge, logging, etc).
export type ToastImplementor = {
  push(toast: ToastItem): void;
  dismiss(id: string): void;
};

// Abstraction: what the app uses. It can grow independently of the implementor.
export type ToastService = {
  info(message: string, options?: { durationMs?: number }): void;
  success(message: string, options?: { durationMs?: number }): void;
  error(message: string, options?: { durationMs?: number }): void;
  dismiss(id: string): void;
};

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E,>(error: E): Result<never, E> => ({ ok: false, error });

const ToastImplContext = React.createContext<ToastImplementor | null>(null);

export const ToastProvider = ({
  implementor,
  children,
}: {
  implementor: ToastImplementor;
  children: React.ReactNode;
}) => <ToastImplContext.Provider value={implementor}>{children}</ToastImplContext.Provider>;

const createToastService = (implementor: ToastImplementor): ToastService => {
  const pushToast = ({ kind, message, durationMs = 4000 }: { kind: ToastKind; message: string; durationMs?: number }) => {
    const id = globalThis.crypto?.randomUUID?.() ?? `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    implementor.push({ id, kind, message, durationMs });
  };

  return {
    info: (message, options) => pushToast({ kind: 'info', message, durationMs: options?.durationMs }),
    success: (message, options) => pushToast({ kind: 'success', message, durationMs: options?.durationMs }),
    error: (message, options) => pushToast({ kind: 'error', message, durationMs: options?.durationMs }),
    dismiss: (id) => implementor.dismiss(id),
  };
};

type UseToastError = { kind: 'missing-toast-provider' };

export const useToast = (): Result<ToastService, UseToastError> => {
  const implementor = React.useContext(ToastImplContext);
  return React.useMemo(() => {
    if (!implementor) {
      return err({ kind: 'missing-toast-provider' });
    }
    return ok(createToastService(implementor));
  }, [implementor]);
};

// Implementor #1: in-app host that renders toasts (common in web apps).
export const ToastHost = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const timeoutsRef = React.useRef<Map<string, ReturnType<typeof globalThis.setTimeout>>>(new Map());

  React.useEffect(() => {
    return () => {
      for (const timeoutId of timeoutsRef.current.values()) {
        globalThis.clearTimeout(timeoutId);
      }
      timeoutsRef.current.clear();
    };
  }, []);

  const dismiss = React.useCallback((id: string) => {
    const timeoutId = timeoutsRef.current.get(id);
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
      timeoutsRef.current.delete(id);
    }
    setToasts((existingToasts) => existingToasts.filter((toast) => toast.id !== id));
  }, []);

  const implementor = React.useMemo<ToastImplementor>(
    () => ({
      push: (toast) => {
        setToasts((existingToasts) => [...existingToasts, toast]);
        const timeoutId = globalThis.setTimeout(() => dismiss(toast.id), toast.durationMs);
        timeoutsRef.current.set(toast.id, timeoutId);
      },
      dismiss,
    }),
    [dismiss],
  );

  return (
    <ToastProvider implementor={implementor}>
      {children}
      <div role="region" aria-label="Notifications" style={{ position: 'fixed', bottom: 12, right: 12 }}>
        {toasts.map((toast) => (
          <div key={toast.id} role="status">
            <strong>{toast.kind}</strong> {toast.message}
            <button onClick={() => dismiss(toast.id)}>Dismiss</button>
          </div>
        ))}
      </div>
    </ToastProvider>
  );
};

// Implementor #2: swap the renderer for tests/SSR/CLI without changing call sites.
export const createConsoleToastImplementor = (): ToastImplementor => ({
  push: (toast) => console.log('[toast]', toast.kind, toast.message),
  dismiss: () => {},
});
```

Now the rest of the app depends on the `ToastService` abstraction (via `useToast()`), while implementations vary by provider (implementor).

## Behavioral Patterns

### Omitted (not React-specific)

- **Strategy** via "pass a function/prop" and **Chain of Responsibility** pipelines are usually plain TypeScript; see `references/snippets/typescript.md`.

### Contents

- Observer (useSyncExternalStore)
- Command (useReducer-managed history)
- State (useReducer state machine)

### Observer (useSyncExternalStore + adapter)

```tsx
import * as React from 'react';

type Listener = () => void;

type Store<T> = { getSnapshot: () => T; subscribe: (l: Listener) => () => void };

// Factory Method: create a minimal external store (Atom).
export type Atom<T> = {
  get: () => T;
  set: (next: T) => void;
  subscribe: (l: Listener) => () => void;
};

export const createAtom = <T,>(initial: T): Atom<T> => {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
};

// Adapter: Atom -> Store interface expected by useSyncExternalStore.
export const toStore = <T,>(atom: Atom<T>): Store<T> => ({
  getSnapshot: atom.get,
  subscribe: atom.subscribe,
});

export const useStore = <T,>(store: Store<T>) =>
  React.useSyncExternalStore(store.subscribe, store.getSnapshot);
```

### Command (undoable UI actions with `useReducer`)

Represent user actions as objects; keep undo/redo in one place.

```tsx
import * as React from 'react';

type Command = { execute: () => void; undo: () => void };

// Decorator: wrap a command with a policy (telemetry, confirmations, etc.).
const withTelemetry = (name: string, inner: Command): Command => ({
  execute: () => {
    console.log('run', name);
    inner.execute();
  },
  undo: () => {
    console.log('undo', name);
    inner.undo();
  },
});

type History = {
  past: Command[];
  present: Command | null;
  future: Command[];
};

type Action =
  | { type: 'push'; command: Command }
  | { type: 'undo' }
  | { type: 'redo' };

// Strategy registry: one state-transition strategy per action type.
type Transitions = {
  [K in Action['type']]: (state: History, action: Extract<Action, { type: K }>) => History;
};

const transitions = {
  push: (state, action) => ({
    past: [...state.past, ...(state.present ? [state.present] : [])],
    present: action.command,
    future: [],
  }),
  undo: (state) => {
    const current = state.present;
    const prev = state.past[state.past.length - 1] ?? null;
    return {
      past: state.past.slice(0, -1),
      present: prev,
      future: current ? [current, ...state.future] : state.future,
    };
  },
  redo: (state) => {
    const next = state.future[0] ?? null;
    if (!next) {
      return state;
    }
    return {
      past: [...state.past, ...(state.present ? [state.present] : [])],
      present: next,
      future: state.future.slice(1),
    };
  },
} satisfies Transitions;

const reducer = (state: History, action: Action): History =>
  // TS needs a small cast because `action.type` is a union key; the strategies remain type-checked above.
  (transitions[action.type] as (s: History, a: Action) => History)(state, action);

export const useCommandHistory = () => {
  const [state, dispatch] = React.useReducer(reducer, { past: [], present: null, future: [] });
  const decorate = React.useCallback((command: Command) => withTelemetry('ui', command), []);
  const run = React.useCallback(
    (command: Command) => {
      const decorated = decorate(command);
      decorated.execute();
      dispatch({ type: 'push', command: decorated });
    },
    [decorate, dispatch],
  );

  const undo = React.useCallback(() => {
    state.present?.undo();
    dispatch({ type: 'undo' });
  }, [state.present, dispatch]);

  const redo = React.useCallback(() => {
    state.future[0]?.execute();
    dispatch({ type: 'redo' });
  }, [state.future, dispatch]);

  return {
    run,
    undo,
    redo,
    canUndo: state.present !== null || state.past.length > 0,
    canRedo: state.future.length > 0,
  };
};
```

### State (state machine via `useReducer`)

You can keep state-specific behavior explicit instead of scattering `if/else` across components.

```tsx
import * as React from 'react';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

type Action = { type: 'load' } | { type: 'ok' } | { type: 'fail'; message: string };

const stateReducer = (state: State, action: Action): State => {
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

export const Example = () => {
  const [state, dispatch] = React.useReducer(stateReducer, { kind: 'idle' });
  return (
    <div>
      <button onClick={() => dispatch({ type: 'load' })}>Load</button>
      <pre>{JSON.stringify(state)}</pre>
    </div>
  );
};
```
