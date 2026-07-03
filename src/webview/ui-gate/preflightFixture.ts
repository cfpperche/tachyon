// spec 342 T4 — the "preflight OFF" mixed fixture (spec.md): representative `.ds-*` legacy markup that must
// compute IDENTICALLY whether or not Tailwind's compiled CSS is linked on the page. A single HTML string
// (not JSX) shared by two consumers — src/webview/ui-gate/main.tsx (injects it via dangerouslySetInnerHTML
// on the REAL gate page, which links Tailwind) and test/browser/support/gateServer.ts (embeds the identical
// markup on a bare `/preflight-fixture-no-tailwind` page that links ONLY design-system.css) — so the
// before/after comparison in test/browser/preflightFixture.test.ts is comparing byte-identical DOM, not two
// hand-maintained copies that could silently drift apart.
export const PREFLIGHT_FIXTURE_HTML = `
<button class="ds-btn ds-btn-primary" data-testid="fixture-button">Primary button</button>
<input class="ds-input" placeholder="text input" data-testid="fixture-input" />
<select class="ds-input" data-testid="fixture-select"><option>One</option><option>Two</option></select>
<table data-testid="fixture-table">
  <thead><tr><th>Col A</th><th>Col B</th></tr></thead>
  <tbody><tr><td>1</td><td>2</td></tr></tbody>
</table>
<ul data-testid="fixture-list"><li>Item one</li><li>Item two</li></ul>
<h2 data-testid="fixture-heading">A heading</h2>
`.trim();
