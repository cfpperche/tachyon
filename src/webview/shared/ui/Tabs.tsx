import { cx } from "./cx";
import { Icon } from "./Icon";

export interface TabItem {
  id: string;
  /** codicon name */
  icon: string;
  label: string;
}

/**
 * spec 282 — the canonical tab row (the Agent Studio surface). Presentation + `onSelect` + a real ARIA tablist; the
 * APP keeps the kind/active/lock LOGIC (it decides what `active` is and may no-op `onSelect` while editing). `locked`
 * is the visual state for the non-active tabs in edit mode.
 */
export function Tabs({ items, active, locked, onSelect }: {
  items: TabItem[];
  active: string;
  locked?: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div class="ds-tabs" role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          class={cx("ds-tab", active === t.id && "active", locked && active !== t.id && "locked")}
          onClick={() => onSelect(t.id)}
        >
          <Icon name={t.icon} />
          {t.label}
        </button>
      ))}
    </div>
  );
}
