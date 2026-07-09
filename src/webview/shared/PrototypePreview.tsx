import { useEffect, useState } from "preact/hooks";
import type { TaskPrototypeListVM } from "../task-prototype/types";

export function PrototypePreview({ value, onSelect }: { value: TaskPrototypeListVM; onSelect?: (id: string) => void }) {
  const preferred = value.prototypes.filter((p) => p.state === "draft").at(-1) ?? value.prototypes.find((p) => p.state === "approved") ?? value.prototypes.at(-1);
  const [selectedId, setSelectedId] = useState(preferred?.id ?? "");
  useEffect(() => {
    if (!value.prototypes.some((p) => p.id === selectedId)) setSelectedId(preferred?.id ?? "");
    onSelect?.(value.prototypes.some((p) => p.id === selectedId) ? selectedId : (preferred?.id ?? ""));
  }, [value.updatedAt, preferred?.id, selectedId, value.prototypes]);
  const selected = value.prototypes.find((p) => p.id === selectedId) ?? preferred;
  if (!selected) return null;
  return (
    <section class="prototype-section" aria-label="Untrusted task prototype">
      <header class="prototype-header">
        <div><strong>Untrusted prototype preview</strong><span class="prototype-static-label">Static · interaction disabled</span></div>
        <select aria-label="Prototype revision" value={selected.id} onChange={(e) => { const id = (e.currentTarget as HTMLSelectElement).value; setSelectedId(id); onSelect?.(id); }}>
          {value.prototypes.map((p, index) => <option key={p.id} value={p.id}>v{index + 1} · {p.state} · {p.title}</option>)}
        </select>
        <div class="prototype-meta"><code>{selected.sha256.slice(0, 12)}</code> · {selected.integrity}</div>
      </header>
      {value.error && <div class="prototype-unavailable">Manifest unavailable: {value.error}</div>}
      {selected.available && selected.staticSrcdoc ? (
        <div class="prototype-gutter">
          <iframe title={`Static prototype: ${selected.title}`} sandbox="" srcDoc={selected.staticSrcdoc} tabIndex={-1} />
          <span class="prototype-watermark" aria-hidden="true">UNTRUSTED · STATIC</span>
        </div>
      ) : <div class="prototype-unavailable">This revision is unavailable ({selected.integrity}).</div>}
    </section>
  );
}
