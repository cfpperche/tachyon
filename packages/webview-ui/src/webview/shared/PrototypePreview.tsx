import { useEffect, useState } from "preact/hooks";
import type { TaskPrototypeListVM } from "../task-prototype/types";

export function PrototypePreview({ value, onSelect }: { value: TaskPrototypeListVM; onSelect?: (id: string) => void }) {
  // t-668b05 (round-1 code-review finding) — `TaskPrototypeListVM.prototypes: TaskPrototypeVM[]` is a
  // compile-time-only guarantee, same as `sha256` below: the actual value is read straight through
  // from an on-disk manifest never runtime-validated, so `.filter`/`.find`/`.some`/`.at`/`.map` on a
  // non-array here would throw BEFORE the sha256 guard is even reached. Normalize once, at the top,
  // rather than defensively re-checking at every call site below.
  const prototypes = Array.isArray(value.prototypes) ? value.prototypes : [];
  const preferred = prototypes.filter((p) => p.state === "draft").at(-1) ?? prototypes.find((p) => p.state === "approved") ?? prototypes.at(-1);
  const [selectedId, setSelectedId] = useState(preferred?.id ?? "");
  useEffect(() => {
    if (!prototypes.some((p) => p.id === selectedId)) setSelectedId(preferred?.id ?? "");
    onSelect?.(prototypes.some((p) => p.id === selectedId) ? selectedId : (preferred?.id ?? ""));
  }, [value.updatedAt, preferred?.id, selectedId, prototypes]);
  const selected = prototypes.find((p) => p.id === selectedId) ?? preferred;
  if (!selected) return null;
  return (
    <section class="prototype-section" aria-label="Untrusted task prototype">
      <header class="prototype-header">
        <div><strong>Untrusted prototype preview</strong><span class="prototype-static-label">Static · interaction disabled</span></div>
        <select aria-label="Prototype revision" value={selected.id} onChange={(e) => { const id = (e.currentTarget as HTMLSelectElement).value; setSelectedId(id); onSelect?.(id); }}>
          {prototypes.map((p, index) => <option key={p.id} value={p.id}>v{index + 1} · {p.state} · {p.title}</option>)}
        </select>
        {/* t-668b05 — `sha256` is a compile-time-only guarantee (TaskPrototypeVM); the actual value is
         *  read straight through from an on-disk manifest record never runtime-validated, so a
         *  missing/malformed one (e.g. an interrupted attach_task_prototype write) must degrade to a
         *  placeholder here instead of throwing during render — an uncaught render exception blanks
         *  the WHOLE Cockpit panel (no error boundary catches it), not just this one section. */}
        <div class="prototype-meta"><code>{typeof selected.sha256 === "string" && selected.sha256 ? selected.sha256.slice(0, 12) : "unknown"}</code> · {selected.integrity}</div>
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
