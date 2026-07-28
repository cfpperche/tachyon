/**
 * SDD 479 phase 1 — a hook runtime for STATIC rendering, aliased over `preact/hooks` when a webview
 * component is bundled by `staticPreact.ts`.
 *
 * Preact's real hooks read `currentComponent`, which only exists inside a `render()` driven by a DOM.
 * This repository's unit suite has no DOM (vitest `environment: "node"`), so a component that calls
 * `useContext` cannot be invoked as a plain function without one. Stubbing the hook MODULE — not the
 * component — keeps the code under test the real source: only the hook runtime is replaced.
 *
 * The stub is deliberately inert (no state transitions, no effects): a card renders from its props,
 * so a static pass sees exactly what the first paint would show. Anything that needed a state
 * transition to become visible would be invisible here, which is why the equality fixtures pass every
 * such input (collapsed, metricsOpen, …) as a prop instead.
 */

const noop = () => {};

/**
 * `useContext` returns a value whose every property is a no-op function. The sidebar's only context is
 * `DispatchCtx` — a bag of host callbacks read during render but CALLED only from event handlers, so a
 * static pass never needs a real one. Presence of the handler is still proven: the serializer records
 * function-valued props as `[fn]`.
 */
const HOST_CALLBACKS: unknown = new Proxy(
  {},
  {
    get: () => noop,
    has: () => true,
  },
);

export function useContext(): unknown {
  return HOST_CALLBACKS;
}

export function useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  return [typeof initial === "function" ? (initial as () => T)() : initial, noop];
}

export function useReducer<S>(_reducer: unknown, initial: S): [S, (action: unknown) => void] {
  return [initial, noop];
}

export function useRef<T>(initial: T | null = null): { current: T | null } {
  return { current: initial };
}

export function useMemo<T>(factory: () => T): T {
  return factory();
}

export function useCallback<T>(fn: T): T {
  return fn;
}

export const useEffect = noop;
export const useLayoutEffect = noop;
export const useImperativeHandle = noop;
export const useDebugValue = noop;
export const useErrorBoundary = () => [undefined, noop];
export const useId = () => "static-id";
