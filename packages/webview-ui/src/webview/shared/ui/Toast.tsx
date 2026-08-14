/**
 * Product Toast — single in-webview feedback system for Control (t-963b66).
 * Preact + design-system tokens. Not Attention (sidebar stack) and not VS Code host notify.
 *
 * Mount ToastProvider once at the Control shell root; views call useToast().show(...).
 * Host messages use { type: "toast", text, tone? } (see cockpit/messages toastMessage).
 */
import { createContext } from "preact";
import { useCallback, useContext, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { cx } from "./cx";
import { Icon } from "./Icon";

export type ToastTone = "info" | "ok" | "warn" | "err";

export interface ToastShowInput {
  message: string;
  tone?: ToastTone;
  /** Optional product context (section/flow) for a11y / future filtering — not Attention. */
  context?: string;
  /** Auto-dismiss ms; 0 = sticky until dismiss. Default 3200. */
  durationMs?: number;
}

export interface ToastItem extends Required<Pick<ToastShowInput, "message" | "tone">> {
  id: string;
  context?: string;
  durationMs: number;
}

export interface ToastApi {
  show: (input: ToastShowInput | string) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON: Record<ToastTone, string> = {
  info: "info",
  ok: "check",
  warn: "warning",
  err: "error",
};

const DEFAULT_DURATION_MS = 3200;
const MAX_STACK = 4;

let toastSeq = 0;
function nextId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

function normalize(input: ToastShowInput | string): ToastShowInput {
  return typeof input === "string" ? { message: input } : input;
}

export function ToastProvider({
  children,
  max = MAX_STACK,
}: {
  children: ComponentChildren;
  max?: number;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((list) => list.filter((x) => x.id !== id));
  }, []);

  const clear = useCallback(() => {
    for (const t of timers.current.values()) window.clearTimeout(t);
    timers.current.clear();
    setItems([]);
  }, []);

  const show = useCallback(
    (input: ToastShowInput | string) => {
      const n = normalize(input);
      const message = n.message.trim();
      if (!message) return "";
      const id = nextId();
      const tone: ToastTone = n.tone ?? "info";
      const durationMs = n.durationMs ?? DEFAULT_DURATION_MS;
      const item: ToastItem = {
        id,
        message,
        tone,
        durationMs,
        ...(n.context ? { context: n.context } : {}),
      };
      setItems((list) => {
        const next = [...list, item];
        return next.length > max ? next.slice(next.length - max) : next;
      });
      if (durationMs > 0) {
        const handle = window.setTimeout(() => dismiss(id), durationMs);
        timers.current.set(id, handle);
      }
      return id;
    },
    [dismiss, max],
  );

  const api = useMemo<ToastApi>(() => ({ show, dismiss, clear }), [show, dismiss, clear]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div class="ds-toast-host" data-testid="toast-host" role="region" aria-label="Notifications">
        <div class="ds-toast-stack" role="status" aria-live="polite" aria-relevant="additions">
          {items.map((t) => (
            <div
              key={t.id}
              class={cx("ds-toast", `ds-toast--${t.tone}`)}
              data-testid="toast"
              data-tone={t.tone}
              data-context={t.context}
            >
              <Icon name={TONE_ICON[t.tone]} />
              <span class="ds-toast-msg">
                {t.context ? <span class="ds-toast-ctx">{t.context}</span> : null}
                {t.message}
              </span>
              <button
                type="button"
                class="ds-toast-dismiss"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

/** Product toast API. Throws if used outside ToastProvider (tests should wrap). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() requires ToastProvider (Control shell host)");
  }
  return ctx;
}

/** Safe variant for optional hosts (returns no-ops when provider missing). */
export function useToastOptional(): ToastApi {
  const ctx = useContext(ToastContext);
  return (
    ctx ?? {
      show: () => "",
      dismiss: () => {},
      clear: () => {},
    }
  );
}
