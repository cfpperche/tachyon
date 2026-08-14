import { Badge, Button, PageChrome } from "../shared/ui";
import type { SectionFixtureModel } from "./protocol";

/**
 * SDD 485 C1–C3 — the section-app proof surface.
 *
 * It renders the MECHANISM, not a domain: which manifest row built this bundle, which cardinality decided
 * this panel's key, what the key came out as, and how many models the host has pushed. That is what makes it
 * a proof rather than a mock — open two identities side by side and the two panels disagree about `key` and
 * `identity` while agreeing about `app`, which is exactly the claim "one manager, cardinality as a
 * parameter" makes.
 *
 * It composes the shared kit (`PageChrome`, `Badge`, `Button`) deliberately: `conform` is the posture it
 * declares in `WEBVIEW_SURFACES`, and a proof surface that hand-rolled its own chrome would be declaring one
 * thing and shipping another. Its second job is to give the splitting build a REAL second consumer of the
 * kit, so "Preact and the kit are extracted into shared chunks" has a witness instead of an intention.
 */
export interface SectionFixtureDispatch {
  refresh(): void;
}

export function App({ model, dispatch }: { model: SectionFixtureModel | undefined; dispatch: SectionFixtureDispatch }) {
  if (!model) {
    return (
      <div class="saf-page">
        <PageChrome title="Section app" hint="Waiting for the host's first model…" />
      </div>
    );
  }
  return (
    <div class="saf-page">
      <PageChrome
        title={model.app}
        hint={`cardinality ${model.cardinality} · last push ${model.lastPush}`}
        actions={<Button onClick={() => dispatch.refresh()}>Refresh</Button>}
      />
      <dl class="saf-facts">
        <dt>panel key</dt>
        <dd class="saf-mono" data-testid="section-app-key">{model.key}</dd>
        <dt>project</dt>
        <dd class="saf-mono">{model.project || "(unscoped)"}</dd>
        <dt>identity</dt>
        <dd class="saf-mono" data-testid="section-app-identity">{model.identity || "(none — dashboard)"}</dd>
        <dt>models received</dt>
        <dd>
          <Badge tone={model.revision > 0 ? "ok" : "warn"}>{String(model.revision)}</Badge>
        </dd>
      </dl>
      <p class="saf-note">
        A hidden panel does no work: this count does not move while the tab is behind another one, and the
        host rebuilds the panel on reveal rather than letting it come back stale.
      </p>
    </div>
  );
}
