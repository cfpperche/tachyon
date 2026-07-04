import type { PinPreviewVM } from "../../sidebar/types";
import { toEditorDoc } from "../rich-doc/document";
import { StaticDoc } from "../rich-doc/StaticDoc";

// spec 279 — the Pin Preview view (converted from SidebarPrototype's inline pinPreviewHtml). Read-only,
// `preact-static`. SECURITY: every user-supplied field (title, body, tags, attachment names) is rendered as
// TEXT — preact escapes by default, so the old hand-rolled escapeHtml()/escapeAttr() are unnecessary AND a
// hostile pin (`<img onerror=…>`, `<script>`) renders as literal text, never as markup. Images load only from
// a host-resolved `uri` (an asWebviewUri blob), never user HTML.

export function App({ vm }: { vm: PinPreviewVM | undefined }) {
  if (!vm) return <main />;
  // t-321e9d — a rich pin renders its actual doc (images/sketches resolve to real webview URIs via the same
  // `toEditorDoc` pipeline the Studio/editor uses); a plain pin (no doc) falls back to the flattened `body`
  // text split on blank lines, same as before.
  const resolvedDoc = vm.doc ? toEditorDoc(vm.doc, vm.attachments) : null;
  const blocks = !resolvedDoc && vm.body ? vm.body.split(/\n{2,}/) : [];
  return (
    <main>
      <header>
        <div class="kicker">Pin Preview</div>
        <h1>{vm.title}</h1>
        <div class="meta">
          <span class="pill">{vm.id}</span>
          {vm.by && <span class="pill">by {vm.by}</span>}
          <span class="pill">{vm.done ? "done" : "open"}</span>
          {vm.tags.map((t) => <span class="tag">#{t}</span>)}
        </div>
      </header>
      <section class="body">
        {resolvedDoc
          ? <StaticDoc doc={resolvedDoc} />
          : (blocks.length ? blocks.map((b) => <p>{b}</p>) : <p class="empty">No body.</p>)}
      </section>
      {vm.attachments.length > 0 && (
        <section class="visuals">
          <h2>Visuals · {vm.attachments.length}</h2>
          {vm.attachments.map((att) => {
            const thumb = att.uri ?? att.previewUri;
            return (
              <article class="visual">
                {thumb ? <img src={thumb} alt="" /> : <div class="missing"><span class="codicon codicon-warning" /></div>}
                <div>
                  <strong>{att.name}</strong>
                  <span>{att.available ? att.detail : `${att.detail} · unavailable`}</span>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
