/**
 * SDD 479 phase 4 — the Control → Settings card-template block (ratified fork 5).
 *
 * Two rules shape this file:
 *
 *  1. **The preview renders the REAL card.** It imports `AgentRow` from the sidebar and the sidebar's
 *     own stylesheet. A preview that can disagree with the shipped card is worse than no preview, so
 *     there is no second renderer and no re-implementation of a row.
 *  2. **…without the sidebar's CSS escaping into Control.** `sidebar.css` is a global sheet — it styles
 *     `body`, `#root`, `.row`, `.name`, `.actions` — so loading it on this page would restyle the
 *     Cockpit. The preview therefore lives in a SHADOW ROOT with its own `<link>`: real CSS, real
 *     component, zero bleed.
 *
 * It never reads live fleet state. The rows are fixtures (`cardPreviewRows.ts`); an editing surface
 * that depended on a running agent would be a second failure mode for no gain.
 */
import { render } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Button } from "../shared/ui";
import { AgentRow } from "../sidebar/App";
import { CARD_PREVIEW_ROWS, CARD_PREVIEW_WIDTHS } from "../../sidebar/cardPreviewRows";
import { CARD_REGIONS, type CardRegion, type CardTemplate } from "../../sidebar/cardTemplate";
import {
  editorStateFrom,
  moveComponent,
  toYaml,
  toggleComponent,
  validate,
  type CardEditorState,
} from "../../cockpit/cardTemplateEditor";
import type { CockpitStrings } from "./messages";

declare global {
  interface Window {
    /**
     * SDD 479 phase 4 — the sidebar stylesheet's webview URI, for the card preview's shadow root.
     * Its own global rather than a `__tachyonSectionStyles` key, because everything in that map is
     * injected into `<head>` — which is exactly what this sheet must never do on the Cockpit page.
     */
    __tachyonCardPreviewCss?: string;
  }
}

/** Guarded for a DOM-less render: the unit suite renders this block statically, in node. */
function sidebarStyleHref(): string | undefined {
  return typeof window === "undefined" ? undefined : window.__tachyonCardPreviewCss;
}

/** The card, rendered by the sidebar's own component inside the shadow root's isolated styles. */
function PreviewCards({ template, href }: { template: CardTemplate; href: string }) {
  return (
    <>
      <link rel="stylesheet" href={href} />
      {/* the sidebar sheet styles `body`, which a shadow root does not have — mirror what it sets */}
      <div style={{ background: "var(--vscode-sideBar-background, var(--vscode-editor-background))", color: "var(--vscode-foreground)", font: "var(--vscode-font-size, 13px) var(--vscode-font-family)" }}>
        {CARD_PREVIEW_WIDTHS.map((width) => (
          <div key={width.id} style={{ marginBottom: "10px" }}>
            <div style={{ fontSize: "10px", opacity: 0.7, padding: "2px 0" }}>{width.label} · {width.px}px</div>
            <div style={{ width: `${width.px}px`, overflow: "hidden", border: "1px solid var(--vscode-panel-border, #4443)" }}>
              {CARD_PREVIEW_ROWS.map((fixture) => (
                <AgentRow key={fixture.id} a={fixture.row} flash={false} cardTemplate={{ base: template }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Hosts `PreviewCards` in a shadow root. Preact renders into the shadow root directly, so the cards
 * are real component instances — not markup copied out of one.
 */
function ShadowPreview({ template }: { template: CardTemplate }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const href = sidebarStyleHref();
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !href) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    render(<PreviewCards template={template} href={href} />, root as unknown as Element);
  }, [template, href]);
  if (!href) {
    // Honest rather than approximate: without the sidebar's own stylesheet this would render a card
    // that is not the card, which is the one thing a preview may not do.
    return <p class="ck-settings-block-body dim" data-testid="card-template-preview-unavailable">—</p>;
  }
  return <div ref={hostRef} data-testid="card-template-preview" />;
}

function RegionEditor({
  s,
  state,
  region,
  onChange,
}: {
  s: CockpitStrings;
  state: CardEditorState;
  region: CardRegion;
  onChange: (next: CardEditorState) => void;
}) {
  return (
    <div class="ck-card-region" data-testid={`card-template-region-${region}`}>
      <h4 class="ck-card-region-title">{region}</h4>
      {state[region].map((entry) => (
        <div key={entry.id} class="ck-card-entry">
          <label class="ck-settings-toggle">
            <input
              type="checkbox"
              checked={entry.shown}
              data-testid={`card-template-toggle-${entry.id}`}
              onChange={() => onChange(toggleComponent(state, region, entry.id))}
            />
            <span>
              <strong>{entry.id}</strong>
              <span class="ck-settings-toggle-help">
                {entry.describes}
                {entry.critical ? ` — ${s.cardTemplateCriticalNote}` : ""}
                {entry.inlineWith ? ` — ${s.cardTemplateInlineNote}` : ""}
              </span>
            </span>
          </label>
          {!entry.inlineWith && (
            <span class="ck-card-entry-move">
              <Button variant="default" onClick={() => onChange(moveComponent(state, region, entry.id, -1))}>↑</Button>
              <Button variant="default" onClick={() => onChange(moveComponent(state, region, entry.id, 1))}>↓</Button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function CardTemplateBlock({ s, onOpenConfig }: { s: CockpitStrings; onOpenConfig: () => void }) {
  const [state, setState] = useState<CardEditorState>(() => editorStateFrom());
  const { template, errors } = validate(state);
  const yaml = toYaml(state);
  return (
    <div class="ck-settings-block" data-testid="control-settings-card-template">
      <h3 class="ck-settings-block-title">{s.cardTemplateTitle}</h3>
      <p class="ck-settings-block-hint">{s.cardTemplateHint}</p>
      <p class="ck-settings-block-body">{s.cardTemplateBody}</p>

      <div class="ck-card-regions">
        {CARD_REGIONS.map((region) => (
          <RegionEditor key={region} s={s} state={state} region={region} onChange={setState} />
        ))}
      </div>

      {errors.length > 0 && (
        // Inline, and BEFORE anything is saved — the same refusals the config loader would produce,
        // because it is the same validator.
        <ul class="ck-card-errors" data-testid="card-template-errors">
          {errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}

      {template && <ShadowPreview template={template} />}

      <p class="ck-settings-block-hint">{s.cardTemplateYamlHint}</p>
      <pre class="ck-card-yaml" data-testid="card-template-yaml">{yaml}</pre>
      <div class="ck-settings-status">
        <Button variant="default" data-testid="card-template-copy" onClick={() => void navigator.clipboard?.writeText(yaml)}>
          {s.cardTemplateCopy}
        </Button>
        <Button variant="default" onClick={onOpenConfig}>{s.settingsOpenConfig}</Button>
        <Button variant="default" onClick={() => setState(editorStateFrom())}>{s.cardTemplateReset}</Button>
      </div>
    </div>
  );
}
