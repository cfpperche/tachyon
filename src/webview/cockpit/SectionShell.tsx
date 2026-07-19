import type { ComponentChildren } from "preact";
import { PageChrome } from "../shared/ui";

/** spec 410 — optional outer chrome for native section bodies that do not own PageChrome. */
export function SectionShell({
  title,
  hint,
  actions,
  children,
  chrome = true,
}: {
  title: string;
  hint?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  /** When false, render children only (section provides its own PageChrome). */
  chrome?: boolean;
}) {
  if (!chrome) return <>{children}</>;
  return (
    <div class="ds-page ck-section-shell">
      <PageChrome title={title} hint={hint} actions={actions} />
      {children}
    </div>
  );
}
