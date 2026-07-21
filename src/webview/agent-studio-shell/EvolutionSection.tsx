import { Button } from "../shared/ui";
import type {
  AgentEvolutionCandidateDetailMessage,
  AgentEvolutionCandidateSummaryMessage,
  AgentEvolutionLabels,
  AgentEvolutionSummaryMessage,
} from "./types";

export interface EvolutionSectionProps {
  labels: AgentEvolutionLabels;
  savedAgent?: string;
  enabled: boolean;
  summary?: AgentEvolutionSummaryMessage;
  candidates?: AgentEvolutionCandidateSummaryMessage[];
  detail?: AgentEvolutionCandidateDetailMessage;
  busy?: string;
  notice?: { kind: "success" | "error"; text: string };
  onToggle(enabled: boolean): void;
  onRefresh(): void;
  onInspect(candidateId: string): void;
  onApprove(detail: AgentEvolutionCandidateDetailMessage): void;
  onReject(detail: AgentEvolutionCandidateDetailMessage): void;
}

function statusLabel(
  status: AgentEvolutionCandidateSummaryMessage["status"],
  labels: AgentEvolutionLabels,
): string {
  if (status === "approved") return labels.approved;
  if (status === "rejected") return labels.rejected;
  return labels.reviewPending;
}

function reviewLabel(summary: AgentEvolutionSummaryMessage, labels: AgentEvolutionLabels): string {
  switch (summary.lastReview?.status) {
    case "pending": return labels.reviewPending;
    case "submitted": return labels.reviewSubmitted;
    case "no-proposal": return labels.reviewNoProposal;
    case "failed": return labels.reviewFailed;
    default: return labels.noReview;
  }
}

function CandidateDetail({ detail, labels }: {
  detail: AgentEvolutionCandidateDetailMessage;
  labels: AgentEvolutionLabels;
}) {
  if (detail.kind === "learning") {
    return <pre class="ash-evolution-diff ash-evolution-diff-proposed">{detail.learningContent}</pre>;
  }

  const current = new Map((detail.currentFiles ?? []).map((file) => [file.path, file]));
  const proposed = new Map((detail.files ?? []).map((file) => [file.path, file]));
  const paths = [...new Set([...current.keys(), ...proposed.keys()])].sort();
  return (
    <div class="ash-evolution-files">
      {paths.map((filePath) => (
        <details class="ash-evolution-file" open={filePath === "SKILL.md"} key={filePath}>
          <summary>{filePath}</summary>
          <div class="ash-evolution-file-diff">
            {current.has(filePath) && (
              <div>
                <div class="ash-evolution-diff-label">{labels.before}</div>
                <pre class="ash-evolution-diff">{current.get(filePath)!.content}</pre>
              </div>
            )}
            <div>
              <div class="ash-evolution-diff-label">{labels.proposed}</div>
              <pre class="ash-evolution-diff ash-evolution-diff-proposed">
                {proposed.get(filePath)?.content ?? labels.none}
              </pre>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

export function EvolutionSection(props: EvolutionSectionProps) {
  const { labels, savedAgent, enabled, summary, candidates, detail, busy, notice } = props;
  const selected = detail && candidates?.some((candidate) => candidate.id === detail.id) ? detail : undefined;
  const actionBusy = busy === "approve" || busy === "reject";

  return (
    <section class="ash-evolution" aria-labelledby="ash-evolution-title">
      <div class="ash-evolution-heading">
        <div>
          <div class="ash-label" id="ash-evolution-title">{labels.title}</div>
          <div class="hint">{labels.description}</div>
        </div>
        <span class={`ash-evolution-state ash-evolution-state-${enabled ? "enabled" : "disabled"}`}>
          {enabled ? labels.enabled : labels.disabled}
        </span>
      </div>

      <label class="check ash-evolution-toggle">
        <input type="checkbox" checked={enabled} onChange={(event) => props.onToggle((event.currentTarget as HTMLInputElement).checked)} />
        {labels.enable}
      </label>
      <div class="hint">{labels.enableHelp}</div>
      <div class="ash-evolution-next-session">{labels.nextSession}</div>

      {!savedAgent ? (
        <div class="ash-evolution-empty">{labels.saveFirst}</div>
      ) : busy === "overview" && !summary ? (
        <div class="ash-evolution-empty" role="status">{labels.loading}</div>
      ) : summary ? (
        <>
          <div class="ash-evolution-toolbar">
            <div class="ash-evolution-metrics">
              <span>{labels.activeVersion}: <strong>{summary.activeVersion}</strong></span>
              <span>{labels.pendingProposals}: <strong>{summary.pendingCount}</strong></span>
            </div>
            <Button icon="refresh" disabled={!!busy} onClick={props.onRefresh}>{labels.refresh}</Button>
          </div>

          {!summary.profilePresent && <div class="hint">{labels.profilePending}</div>}

          <div class={`ash-evolution-review ${summary.lastReview?.status === "failed" ? "ash-evolution-review-failed" : ""}`}>
            <strong>{labels.lastReview}:</strong> {reviewLabel(summary, labels)}
            {summary.lastReview && (
              <span> · {summary.lastReview.taskTitle} ({summary.lastReview.taskId})</span>
            )}
            {summary.lastReview?.failure && <div>{summary.lastReview.failure}</div>}
          </div>

          <div class="ash-evolution-active-grid">
            <div>
              <div class="ash-evolution-subtitle">{labels.activeLearnings}</div>
              {summary.activeLearnings.length > 0
                ? <ul>{summary.activeLearnings.map((learning) => <li key={learning.id}>{learning.content}</li>)}</ul>
                : <div class="hint">{labels.none}</div>}
            </div>
            <div>
              <div class="ash-evolution-subtitle">{labels.activeSkills}</div>
              {summary.activeSkillNames.length > 0
                ? <div class="ash-evolution-skill-list">{summary.activeSkillNames.map((name) => <code key={name}>{name}</code>)}</div>
                : <div class="hint">{labels.none}</div>}
            </div>
          </div>

          <div class="ash-evolution-subtitle">{labels.proposals}</div>
          {candidates === undefined ? (
            <div class="ash-evolution-empty" role="status">{labels.loading}</div>
          ) : candidates.length === 0 ? (
            <div class="ash-evolution-empty">{labels.noProposals}</div>
          ) : (
            <div class="ash-evolution-candidates">
              {candidates.map((candidate) => (
                <button
                  type="button"
                  aria-label={`${labels.inspect}: ${candidate.skillName ?? candidate.kind}`}
                  class={`ash-evolution-candidate ${selected?.id === candidate.id ? "ash-evolution-candidate-selected" : ""}`}
                  key={candidate.id}
                  disabled={!!busy}
                  onClick={() => props.onInspect(candidate.id)}
                >
                  <span>
                    <strong>{candidate.kind === "learning" ? labels.learning : candidate.skillName ?? labels.skill}</strong>
                    {candidate.operation && <span> · {candidate.operation === "create" ? labels.create : labels.update}</span>}
                  </span>
                  <span>{candidate.taskTitle ?? candidate.taskId}</span>
                  <span class={`ash-evolution-candidate-status ash-evolution-candidate-status-${candidate.status}`}>
                    {statusLabel(candidate.status, labels)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {busy?.startsWith("candidate:") && !selected && (
            <div class="ash-evolution-empty" role="status">{labels.loading}</div>
          )}

          {selected && (
            <article class="ash-evolution-detail">
              <div class="ash-evolution-detail-heading">
                <strong>{selected.kind === "learning" ? labels.learning : selected.skillName ?? labels.skill}</strong>
                <span class={`ash-evolution-candidate-status ash-evolution-candidate-status-${selected.status}`}>
                  {statusLabel(selected.status, labels)}
                </span>
              </div>
              <div><strong>{labels.sourceTask}:</strong> {selected.taskTitle ?? selected.taskId} ({selected.taskId})</div>
              <div><strong>{labels.reason}:</strong> {selected.reason}</div>
              <CandidateDetail detail={selected} labels={labels} />
              <div class="ash-evolution-next-session">{labels.nextSession}</div>
              {selected.status === "pending" && (
                <div class="ash-evolution-actions">
                  <Button disabled={actionBusy} onClick={() => props.onReject(selected)}>{labels.reject}</Button>
                  <Button variant="primary" disabled={actionBusy} onClick={() => props.onApprove(selected)}>{labels.approve}</Button>
                </div>
              )}
            </article>
          )}
        </>
      ) : (
        <div class="ash-evolution-empty" role="status">{labels.loading}</div>
      )}

      {notice && (
        <div class={`ash-evolution-notice ash-evolution-notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </div>
      )}
    </section>
  );
}
