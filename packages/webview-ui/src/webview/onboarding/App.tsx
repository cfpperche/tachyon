import { Badge, Button, EmptyState, Icon, PageChrome } from "../shared/ui";
import type { OnboardingAction, OnboardingFolder, OnboardingModel } from "./messages";

/**
 * t-505f13 — the Onboarding app. Three steps with visible progress, a doctor-pattern environment
 * checklist that names what is MISSING, and the workspace bootstrap behind the same `tachyon.init`
 * door the command palette uses. Nothing is a wizard: every step is on the page at once, a ready
 * environment reads as done, and a configured workspace collapses the screen to "You're set up" —
 * the experienced user is never walked through anything.
 */

type StepState = "waiting" | "current" | "done";

function stepState(done: boolean, reachable: boolean): StepState {
  if (done) return "done";
  return reachable ? "current" : "waiting";
}

function EnvRow({ item, dispatch }: { item: OnboardingModel["environment"]["items"][number]; dispatch: (action: OnboardingAction) => void }) {
  const tone = item.status === "ok" ? "ok" : item.status === "missing" ? "warn" : "info";
  const icon = item.status === "ok" ? "check" : item.status === "missing" ? "error" : "info";
  return (
    <article class={`onb-env-row onb-${item.status}`} data-testid={`onb-env-${item.id}`}>
      <div class="onb-env-head">
        <span class="onb-env-label">{item.label}</span>
        <Badge tone={tone}><Icon name={icon} /> {item.status === "ok" ? "ok" : item.status === "missing" ? "missing" : "later"}</Badge>
        {/* The actions slot is rendered on EVERY row, empty when there is nothing to do: that is what
            keeps the badge above it a column with one constant right edge (owner validation, devhost). */}
        <span class="onb-head-actions">
          {item.id === "credential" && item.status === "missing"
            && <Button data-testid="onb-open-keys" onClick={() => dispatch({ type: "openKeys" })}>Open Keys</Button>}
        </span>
      </div>
      <div class="ds-dim">{item.detail}</div>
      {item.status === "missing" && item.remedy && <div class="onb-remedy"><Icon name="lightbulb" /> {item.remedy}</div>}
    </article>
  );
}

function FolderRow({ folder, environmentReady, dispatch }: { folder: OnboardingFolder; environmentReady: boolean; dispatch: (action: OnboardingAction) => void }) {
  return (
    <article class="onb-folder" data-testid={`onb-folder-${folder.name}`}>
      <div class="onb-env-head">
        <span class="onb-env-label"><Icon name="folder" /> {folder.name}</span>
        {folder.configured
          ? <Badge tone="ok"><Icon name="check" /> tachyon.yml present</Badge>
          : <Badge tone="warn"><Icon name="warning" /> not initialized</Badge>}
        <span class="onb-head-actions">
          {folder.configured
            ? <Button data-testid="onb-open-config" onClick={() => dispatch({ type: "openConfig" })}>Open tachyon.yml</Button>
            : <Button variant="primary" icon="rocket" disabled={!environmentReady} data-testid="onb-initialize"
                title={environmentReady ? "Generate a starter tachyon.yml in this workspace" : "Fix the missing environment items first"}
                onClick={() => dispatch({ type: "initialize" })}>Initialize this workspace</Button>}
        </span>
      </div>
      <div class="ds-dim onb-folder-root">{folder.root}</div>
    </article>
  );
}

export function App({ model, dispatch }: { model?: OnboardingModel; dispatch: (action: OnboardingAction) => void }) {
  if (!model) {
    return <main class="ds-page onboarding-root"><EmptyState kind="loading" message="Checking this machine…" /></main>;
  }

  const env = model.environment;
  const folders = model.folders;
  const hasFolder = folders.length > 0;
  const unconfigured = folders.filter((f) => !f.configured);
  const attached = folders.some((f) => f.attached);
  const agentCount = model.agentCount ?? 0;
  // Step reachability: bootstrap is worth offering once the environment can actually run an agent;
  // the first agent needs an attached workspace. An unbootable environment must not invite a
  // bootstrap that would only produce a workspace the engine refuses to start.
  const envDone = env.ready;
  const workspaceDone = hasFolder && unconfigured.length === 0;
  const agentDone = agentCount > 0;
  const steps: Array<{ id: string; label: string; state: StepState }> = [
    { id: "environment", label: "Check the environment", state: stepState(envDone, true) },
    { id: "workspace", label: "Initialize the workspace", state: stepState(workspaceDone, envDone && hasFolder) },
    { id: "agent", label: "Start your first agent", state: stepState(agentDone, attached) },
  ];
  const allSet = envDone && workspaceDone && agentDone;

  return <main class="ds-page onboarding-root" data-testid="onb-root">
    <PageChrome
      title="Onboarding"
      hint="Tachyon runs AI coding agents as a managed fleet — real terminals, a shared board, human approvals."
      actions={<Button icon="refresh" data-testid="onb-recheck" onClick={() => dispatch({ type: "recheck" })}>Re-check</Button>}
    />

    <ol class="onb-steps" data-testid="onb-steps">
      {steps.map((step, index) => (
        <li key={step.id} class={`onb-step onb-${step.state}`} data-testid={`onb-step-${step.id}`} data-state={step.state}>
          <span class="onb-step-dot">{step.state === "done" ? <Icon name="check" /> : index + 1}</span>
          <span class="onb-step-label">{step.label}</span>
        </li>
      ))}
    </ol>

    {allSet && (
      <div class="ds-banner onb-allset" data-testid="onb-allset">
        <Icon name="check" /> You're set up — the fleet lives in the Tachyon sidebar. Create more agents any time in Agent Studio.
      </div>
    )}

    <section class="onb-section" aria-label="Environment">
      <h2>Environment</h2>
      <p class="ds-dim">What Tachyon needs on this machine. Checked {new Date(env.checkedAt).toLocaleTimeString()}.{!env.ready && " Fix the missing items, then Re-check."}</p>
      <div class="onb-env-list">
        {env.items.map((item) => <EnvRow key={item.id} item={item} dispatch={dispatch} />)}
      </div>
    </section>

    <section class="onb-section" aria-label="Workspace">
      <h2>Workspace</h2>
      {!hasFolder
        ? <EmptyState icon="folder" message={<>Open a folder first — then initialize it here.<br />The starter <code>tachyon.yml</code> is a teaching artifact: commented, valid, yours to edit.</>} />
        : <div class="onb-folder-list">
            {folders.map((folder) => <FolderRow key={folder.root} folder={folder} environmentReady={env.ready} dispatch={dispatch} />)}
          </div>}
    </section>

    <section class="onb-section" aria-label="First agent">
      <h2>First agent</h2>
      {!attached
        ? <p class="ds-dim" data-testid="onb-agent-waiting">Initializes with the workspace — an agent needs a Tachyon workspace to live in.</p>
        : agentDone
          ? <p class="ds-dim" data-testid="onb-agent-done">{agentCount} agent{agentCount === 1 ? "" : "s"} in the roster. Start sessions from the Tachyon sidebar (▶).</p>
          : <div class="onb-agent-launch" data-testid="onb-agent-ready">
              <p class="ds-dim">A named session of claude, codex or grok, with its own profile and worktree.</p>
              <Button variant="primary" icon="hubot" data-testid="onb-open-studio" onClick={() => dispatch({ type: "openAgentStudio" })}>Open Agent Studio</Button>
            </div>}
    </section>
  </main>;
}
