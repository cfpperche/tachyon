/**
 * Product QuickPicker — in-webview filterable pick list (replaces vscode.window.showQuickPick
 * for surfaces that already own the candidate set). Preact + design-system tokens; keyboard:
 * ↑↓ navigate, Enter select, Escape close, click scrim close.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cx } from "./cx";

export interface QuickPickerItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  /** When true, row is listed but not selectable. */
  disabled?: boolean;
  /** Shown as description when disabled (overrides description if set). */
  disabledReason?: string;
}

export interface QuickPickerProps {
  open: boolean;
  title: string;
  /** Optional honesty / context line under the title. */
  subtitle?: string;
  placeholder?: string;
  items: QuickPickerItem[];
  emptyText?: string;
  /** Footer left hint (defaults to key legend). */
  footerHint?: string;
  onClose: () => void;
  onSelect: (item: QuickPickerItem) => void;
  /** test id root */
  "data-testid"?: string;
}

function filterItems(items: QuickPickerItem[], q: string): QuickPickerItem[] {
  const t = q.trim().toLowerCase();
  if (!t) return items;
  return items.filter((it) => {
    const hay = `${it.label} ${it.description ?? ""} ${it.detail ?? ""} ${it.disabledReason ?? ""}`.toLowerCase();
    return hay.includes(t);
  });
}

/** First enabled index in `list`, or 0 if all disabled / empty. */
function firstEnabledIndex(list: QuickPickerItem[]): number {
  const i = list.findIndex((it) => !it.disabled);
  return i >= 0 ? i : 0;
}

export function QuickPicker({
  open,
  title,
  subtitle,
  placeholder = "Filter…",
  items,
  emptyText = "No matches",
  footerHint,
  onClose,
  onSelect,
  "data-testid": testId = "quick-picker",
}: QuickPickerProps) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterItems(items, q), [items, q]);
  // Stable identity for the open→reset effect (parent may pass a fresh array each render).
  const itemKey = useMemo(() => items.map((it) => `${it.id}:${it.disabled ? 1 : 0}`).join("|"), [items]);

  // Reset filter + selection when the dialog opens or the candidate set identity changes.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(firstEnabledIndex(items));
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- items read via itemKey identity
  }, [open, itemKey]);

  useEffect(() => {
    if (sel >= matches.length) setSel(matches.length ? firstEnabledIndex(matches) : 0);
  }, [matches.length, sel, matches]);

  // Keep active option in view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${testId}-opt-${sel}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, open, testId]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!matches.length) return;
        setSel((s) => {
          let n = s;
          for (let step = 0; step < matches.length; step++) {
            n = (n + 1) % matches.length;
            if (!matches[n]?.disabled) return n;
          }
          return s;
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!matches.length) return;
        setSel((s) => {
          let n = s;
          for (let step = 0; step < matches.length; step++) {
            n = (n - 1 + matches.length) % matches.length;
            if (!matches[n]?.disabled) return n;
          }
          return s;
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = matches[sel];
        if (it && !it.disabled) onSelect(it);
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [open, matches, sel, onClose, onSelect]);

  if (!open) return null;

  return (
    <div
      class="ds-qp open"
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="ds-qp-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={`${testId}-panel`}
      >
        <div class="ds-qp-head">
          <div class="ds-qp-title">{title}</div>
          {subtitle ? <div class="ds-qp-subtitle">{subtitle}</div> : null}
        </div>
        <input
          ref={inputRef}
          class="ds-qp-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${testId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={matches.length ? `${testId}-opt-${sel}` : undefined}
          placeholder={placeholder}
          aria-label={placeholder}
          value={q}
          data-testid={`${testId}-filter`}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
        />
        <div
          class="ds-qp-results"
          role="listbox"
          id={`${testId}-list`}
          ref={listRef}
          aria-label={title}
          data-testid={`${testId}-list`}
        >
          {matches.length === 0 ? (
            <div class="ds-qp-empty" data-testid={`${testId}-empty`}>
              {emptyText}
            </div>
          ) : (
            matches.map((m, i) => {
              const disabled = !!m.disabled;
              const desc = disabled && m.disabledReason ? m.disabledReason : m.description;
              return (
                <div
                  key={m.id}
                  id={`${testId}-opt-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  aria-disabled={disabled || undefined}
                  class={cx("ds-qp-item", i === sel && "sel", disabled && "disabled")}
                  data-testid={`${testId}-item`}
                  data-id={m.id}
                  data-disabled={disabled ? "true" : undefined}
                  onMouseEnter={() => {
                    if (!disabled) setSel(i);
                  }}
                  onClick={() => {
                    if (!disabled) onSelect(m);
                  }}
                >
                  <div class="ds-qp-item-main">
                    <span class="ds-qp-label">{m.label}</span>
                    {desc ? <span class="ds-qp-desc">{desc}</span> : null}
                  </div>
                  {m.detail ? <div class="ds-qp-detail">{m.detail}</div> : null}
                </div>
              );
            })
          )}
        </div>
        <div class="ds-qp-foot">
          <span>{footerHint ?? (
            <>
              <kbd>↑↓</kbd>navigate <kbd>↵</kbd>select <kbd>esc</kbd>close
            </>
          )}</span>
        </div>
      </div>
    </div>
  );
}
