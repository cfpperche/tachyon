/**
 * t-e722ce — the plan a human reads before approving a forget.
 *
 * Pure render over `AgentForgetPlanResultV1`: it computes nothing and decides nothing. Every fact
 * on screen was measured by `Workspace.planAgentProfileForget` against the same sources the cascade
 * consults, so a reader can trust that "will run" and "already satisfied" are the transaction's own
 * words and not this component's guess.
 *
 * The three states are rendered as three DIFFERENT things rather than three colours of the same row.
 * "Already satisfied" is the state the old flow never had a way to say, and its absence is what sent
 * a human off to satisfy a precondition that was already met — twice, through the wrong surface.
 */
import type {
  AgentForgetPlanResultV1,
  AgentForgetPlanStepId,
  AgentForgetPlanV1,
} from "../../config/agentForgetPlan";

const STEP_TITLES: Record<AgentForgetPlanStepId, string> = {
  "stop-session": "Stop the session",
  "remove-worktree": "Release the worktree",
  "retire-evolution": "Retire the Agent Evolution profile",
  "retire-authority": "Retire the host authority",
  "remove-locator": "Remove it from tachyon.yml",
  "quarantine-profile": "Retire the canonical profile",
  "converge-runtime": "Converge runtime state",
};

const STATE_LABELS = {
  "satisfied": "already satisfied",
  "will-run": "will run",
  "blocked": "blocked",
} as const;

function RiskLine({ plan }: { plan: AgentForgetPlanV1 }): preact.JSX.Element | null {
  const risk = plan.risk;
  const notes: string[] = [];
  if (risk.uncommittedChanges > 0) {
    notes.push(`${risk.uncommittedChanges} uncommitted change${risk.uncommittedChanges === 1 ? "" : "s"} will be lost`);
  }
  // An unmeasurable ahead-count is reported as unmeasurable. A confident "0 commits ahead" that the
  // probe never established is the one number here that could talk somebody into losing work.
  if (risk.aheadProbeFailed) notes.push("commits ahead of base could NOT be measured");
  else if (risk.commitsAheadOfBase > 0) {
    notes.push(`${risk.commitsAheadOfBase} commit${risk.commitsAheadOfBase === 1 ? "" : "s"} ahead of base, ${risk.unpushedCommits} unpushed`);
  }
  if (risk.branchDeletionPlanned && risk.branch) {
    notes.push(`branch ${risk.branch} is deleted if git can safe-delete it`);
  }
  if (notes.length === 0) return null;
  return <div class="ash-forget-plan-risk">⚠ {notes.join("; ")}</div>;
}

export function ForgetPlanView({ result }: { result?: AgentForgetPlanResultV1 }): preact.JSX.Element {
  if (!result) return <div class="ash-forget-plan-pending">Computing what this will do…</div>;
  if (result.kind === "refused") {
    // The engine's own sentence, verbatim. It named a gesture; repeating it is the entire point.
    return (
      <div class="ash-forget-plan-refused">
        <div>The plan could not be computed.</div>
        <div>{result.message}</div>
        <div class="hint ash-mono">{result.code}</div>
      </div>
    );
  }
  const plan = result.plan;
  return (
    <div class="ash-forget-plan" aria-label="Forget plan">
      <ol class="ash-forget-plan-steps">
        {plan.steps.map((step) => (
          <li key={step.id} class={`ash-forget-plan-step ash-forget-plan-step-${step.state}`}>
            <span class="ash-forget-plan-step-title">{STEP_TITLES[step.id]}</span>
            <span class="ash-forget-plan-step-state">{STATE_LABELS[step.state]}</span>
            <span class="ash-forget-plan-step-detail">{step.detail}</span>
            {step.resolution ? <span class="ash-forget-plan-step-resolution">{step.resolution}</span> : null}
            {/* Column 3 with the detail it belongs to. Left in the first column it read as a caption
                for the NEXT step — a misattributed refusal code is worse than none. */}
            {step.refusalCode ? <span class="hint ash-mono ash-forget-plan-step-code">{step.refusalCode}</span> : null}
          </li>
        ))}
      </ol>
      <RiskLine plan={plan} />
      <div class="ash-forget-plan-retained">
        <strong>Not deleted:</strong> {plan.retained.join(", ")}
      </div>
      <div class="ash-forget-plan-retained">
        <strong>Kept in the retirement receipt:</strong> {plan.retiredToReceipt.join(", ")}
      </div>
      {plan.dissent.length > 0 && (
        <div class="ash-forget-plan-dissent">
          {/* Reported, never acted on: the plan follows the session ledger because the transaction
              does. Showing the disagreement is how a human stops trusting a surface that reads a
              different source — which is what sent one through Control → Worktrees to no effect. */}
          <div><strong>Sources that disagree</strong> (the session ledger decides):</div>
          <ul>
            {plan.dissent.map((entry) => <li key={entry.source}>{entry.claim}</li>)}
          </ul>
        </div>
      )}
      {!plan.executable && (
        <div class="ash-forget-plan-blocked-note">
          Resolve the blocked step above; nothing has been changed.
        </div>
      )}
    </div>
  );
}
