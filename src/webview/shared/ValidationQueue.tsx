import type { ComponentChildren } from "preact";
import type { ValidationOutcome } from "../../validations/types";
import type { buildBoardModel } from "../../tasks/boardModel";
import { Badge, Button, Input, Icon } from "../shared/ui";

export type BoardValidationsVM = NonNullable<ReturnType<typeof buildBoardModel>["validations"]>;

export type ValidationCloseState = { id: string; outcome: ValidationOutcome; note: string };

export interface ValidationQueueProps {
  validations: BoardValidationsVM | undefined;
  closeState: ValidationCloseState | null;
  onSelect(id: string): void;
  onChange(patch: Partial<{ outcome: ValidationOutcome; note: string }>): void;
  onCancel(): void;
  onSubmit(): void;
  /**
   * `strip` — compact bar (legacy Mission placement; prefer dedicated Control tab).
   * `page` — full Control → Validations surface (always visible empty state).
   */
  layout?: "strip" | "page";
  /** Optional header actions (e.g. refresh) for page layout. */
  headerActions?: ComponentChildren;
}

/** Shared Validations queue UI (t-b87bfe) — strip or full page. */
export function ValidationQueue({
  validations,
  closeState,
  onSelect,
  onChange,
  onCancel,
  onSubmit,
  layout = "page",
  headerActions,
}: ValidationQueueProps) {
  const empty = !validations || (validations.pendingCount === 0 && validations.candidateCount === 0);
  const selected = closeState && validations ? validations.cards.find((v) => v.id === closeState.id) : undefined;

  if (layout === "strip" && empty) return null;

  const body = (
    <>
      <div class="validation-summary">
        <span class="validation-icon"><Icon name="checklist" /></span>
        <strong>Validations</strong>
        {!empty && validations && (
          <>
            <Badge tone={validations.pendingCount > 0 ? "warn" : "info"}>{validations.pendingCount} pending</Badge>
            {validations.humanPendingCount > 0 && <span class="validation-count">{validations.humanPendingCount} human</span>}
            {validations.agentPendingCount > 0 && <span class="validation-count">{validations.agentPendingCount} agent</span>}
            {validations.candidateCount > 0 && <span class="validation-count">{validations.candidateCount} candidates</span>}
          </>
        )}
        {empty && <Badge tone="info">0 pending</Badge>}
        {headerActions}
      </div>
      {empty && (
        <p class="validation-empty" data-testid="validations-empty">
          No open validations. Mission stays task-only — create validations from tasks or discovery when needed.
        </p>
      )}
      {!empty && validations && validations.cards.length > 0 && (
        <div class={`validation-list${layout === "page" ? " validation-list-page" : ""}`}>
          {validations.cards.map((v) => (
            <button
              key={v.id}
              type="button"
              class={`validation-pill${closeState?.id === v.id ? " selected" : ""}`}
              title={`${v.status} · ${v.executor}${v.assignee ? ` · ${v.assignee}` : ""}`}
              onClick={() => onSelect(v.id)}
            >
              <span class="ref">{v.id}</span>
              {v.type && <span class="validation-type">{v.type}</span>}
              <span class="validation-title">{v.title}</span>
              {v.priority !== undefined && <span class={`prio p${v.priority}`}>P{v.priority}</span>}
            </button>
          ))}
        </div>
      )}
      {!empty && validations && validations.cards.length === 0 && validations.candidateTitles.length > 0 && (
        <div class={`validation-list${layout === "page" ? " validation-list-page" : ""}`}>
          {validations.candidateTitles.map((title) => (
            <span key={title} class="validation-pill candidate"><span class="validation-title">{title}</span></span>
          ))}
        </div>
      )}
      {selected && closeState && (
        <div class="validation-close">
          <span class="validation-close-title">Close {selected.id}</span>
          <select
            aria-label="Validation outcome"
            value={closeState.outcome}
            onChange={(e) => onChange({ outcome: (e.currentTarget as HTMLSelectElement).value as ValidationOutcome })}
          >
            <option value="passed">passed</option>
            <option value="failed">failed</option>
            <option value="skipped">skipped</option>
          </select>
          <Input
            value={closeState.note}
            placeholder="note or evidence ref"
            onInput={(e) => onChange({ note: (e.currentTarget as HTMLInputElement).value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
              if (e.key === "Escape") onCancel();
            }}
          />
          <Button icon="check" onClick={onSubmit}>Close</Button>
          <Button icon="close" onClick={onCancel} />
        </div>
      )}
    </>
  );

  if (layout === "strip") {
    return (
      <section class="validation-strip" aria-label="Validation queue" data-testid="validations-strip">
        {body}
      </section>
    );
  }

  return (
    <section class="validation-page" aria-label="Validations" data-testid="control-validations">
      {body}
    </section>
  );
}
