import type { ComponentChildren, JSX } from "preact";
import { cx } from "./cx";
import { Icon } from "./Icon";

export interface PageChromeProps {
  title: ComponentChildren;
  /** @deprecated Editor pages must not use title icons (Fleet chrome). Ignored. */
  icon?: string;
  /** t-bf3498 — a subroute's "← Parent" back-link, rendered as a compact line under the title. */
  backLink?: ComponentChildren;
  hint?: ComponentChildren;
  actions?: ComponentChildren;
  class?: string;
}

/** Shared page header for webviews and Control tabs. */
export function PageChrome({ title, icon: _icon, backLink, hint, actions, class: cls }: PageChromeProps) {
  return (
    <div class={cx("ds-page-chrome", cls)}>
      <div class="ds-page-chrome-text">
        <h1 class="ds-page-chrome-title">{title}</h1>
        {backLink ? <div class="ds-page-chrome-backlink">{backLink}</div> : null}
        {hint != null && hint !== false ? <p class="ds-page-chrome-hint">{hint}</p> : null}
      </div>
      {actions ? <div class="ds-page-chrome-actions">{actions}</div> : null}
    </div>
  );
}

export type ListRowState = "idle" | "hover" | "selected" | "current";

export interface ListRowProps {
  as?: "article" | "div" | "li";
  state?: ListRowState;
  leading?: ComponentChildren;
  title: ComponentChildren;
  meta?: ComponentChildren;
  detail?: ComponentChildren;
  actions?: ComponentChildren;
  /**
   * t-ea5425 — a block that belongs to the whole row rather than to its text column: it starts under
   * the leading edge and runs to the card's far border, BELOW both the main column and the actions.
   *
   * `detail` is the wrong slot for such a block and the difference is measurable, not stylistic. It
   * lives inside `.ds-list-row-main`, which shares the row with `.ds-list-row-actions`; measured on the
   * Worktrees land block at 880, that left it 480px of an 824px card (0.58) and wrapped its one
   * actionable sentence over five lines. A row with no `footer` renders exactly as before.
   */
  footer?: ComponentChildren;
  class?: string;
  onClick?: JSX.MouseEventHandler<HTMLElement>;
}

/** Dense list/entity row — fleet, worktrees, deliveries, settings lists. */
export function ListRow({
  as = "article",
  state = "idle",
  leading,
  title,
  meta,
  detail,
  actions,
  footer,
  class: cls,
  onClick,
}: ListRowProps) {
  // The wrap modifier is a class rather than `:has(> .ds-list-row-footer)` so the row a footer changes
  // is the row that ASKED for one: every existing row keeps `nowrap` and its measured behaviour.
  const className = cx("ds-list-row", footer != null ? "ds-list-row-has-footer" : undefined, cls);
  const dataState = state === "idle" ? undefined : state;
  const body = (
    <>
      {leading ? <div class="ds-list-row-leading">{leading}</div> : null}
      <div class="ds-list-row-main">
        <div class="ds-list-row-title">{title}</div>
        {meta != null ? <div class="ds-list-row-meta">{meta}</div> : null}
        {detail != null ? <div class="ds-list-row-detail">{detail}</div> : null}
      </div>
      {actions ? <div class="ds-list-row-actions">{actions}</div> : null}
      {footer != null ? <div class="ds-list-row-footer">{footer}</div> : null}
    </>
  );
  if (as === "li") {
    return (
      <li class={className} data-state={dataState} onClick={onClick as JSX.MouseEventHandler<HTMLLIElement> | undefined}>
        {body}
      </li>
    );
  }
  if (as === "div") {
    return (
      <div class={className} data-state={dataState} onClick={onClick as JSX.MouseEventHandler<HTMLDivElement> | undefined}>
        {body}
      </div>
    );
  }
  return (
    <article class={className} data-state={dataState} onClick={onClick as JSX.MouseEventHandler<HTMLElement> | undefined}>
      {body}
    </article>
  );
}

export type EmptyStateKind = "empty" | "loading" | "error";

export interface EmptyStateProps {
  kind?: EmptyStateKind;
  icon?: string;
  message: ComponentChildren;
  action?: ComponentChildren;
  class?: string;
}

const DEFAULT_ICON: Record<EmptyStateKind, string> = {
  empty: "inbox",
  loading: "loading",
  error: "error",
};

/** Shared empty / loading / error placeholder. */
export function EmptyState({ kind = "empty", icon, message, action, class: cls }: EmptyStateProps) {
  const iconName = icon ?? DEFAULT_ICON[kind];
  const role = kind === "error" ? "alert" : kind === "loading" ? "status" : undefined;
  return (
    <div class={cx("ds-empty-state", kind !== "empty" && `ds-empty-state--${kind}`, cls)} role={role}>
      <Icon name={iconName} />
      <div class="ds-empty-state-msg">{message}</div>
      {action ? <div class="ds-empty-state-action">{action}</div> : null}
    </div>
  );
}

/**
 * Sidebar-density row (pipelines / schedules / commands / runbooks).
 * DOM keeps `.row` / `.row-top` / `.row-meta` / `.actions` so surface CSS (hover actions, child indent) stays valid.
 */
export interface DenseRowProps {
  /** Status dot class suffix (e.g. running | stopped | idle); omit for no dot. */
  dot?: string | null;
  name: string;
  sub?: string;
  meta?: ComponentChildren;
  /** Nested under a Group (indent + ↳). */
  child?: boolean;
  actions?: ComponentChildren;
  class?: string;
}

export function DenseRow({ dot, name, sub, meta, child, actions, class: cls }: DenseRowProps) {
  return (
    <div class={cx("row", "ds-dense-row", child && "child", cls)} data-name={name.toLowerCase()}>
      <div class="row-top">
        {dot ? <span class={cx("sdot", dot)} aria-hidden="true" /> : null}
        <span class="name">{name}</span>
        {sub ? <span class="msub">· {sub}</span> : null}
      </div>
      {meta != null ? <div class="row-meta">{meta}</div> : null}
      {actions ? <div class="actions">{actions}</div> : null}
    </div>
  );
}
