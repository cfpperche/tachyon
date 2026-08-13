import { useEffect, useRef, useState } from "preact/hooks";

const STYLE_KEYS = ["color", "backgroundColor", "fontSize", "fontWeight", "fontFamily", "display", "padding", "margin", "border", "borderRadius", "width", "height", "position", "flexDirection", "gap", "justifyContent", "alignItems"] as const;

export type DesignModeOverlayOptions = {
  bindingName: string;
  focusColor: string;
  restorePickMode: boolean;
};

type PickElement = HTMLElement & { innerText?: string };
type Intent = "change" | "question";

type Capture = {
  page: { url: string; title: string; viewport: { width: number; height: number }; scroll: { x: number; y: number }; dpr: number; capturedAt: string };
  target: { selector: string; tag: string; id: string; className: string; text: string; html: string; attributes: Record<string, string>; accessibility: { role: string; label: string }; bounds: { x: number; y: number; width: number; height: number }; pageBounds: { x: number; y: number; width: number; height: number }; styles: Record<string, string> };
  context: { parentText: string; previousText: string; nextText: string };
};

export type DesignModeAnnotation = Capture & {
  index: number;
  intent: Intent;
  comment: string;
  screenshotPath?: string;
  screenshotPreview?: string;
};

export type DesignModeAgentState = { agents: string[]; active?: string; emptyReason?: string };
export type DesignModeSendState = { status: "idle" | "sending" | "sent" | "error"; text?: string };
export type DesignModeViewportPreset = "phone" | "tablet" | "desktop" | "reset";
export type DesignModeViewportState = { preset: DesignModeViewportPreset; status: "idle" | "setting" | "success" | "error"; text?: string };

const VIEWPORT_PRESETS: Array<{ preset: DesignModeViewportPreset; label: string }> = [
  { preset: "phone", label: "Phone 375×812" },
  { preset: "tablet", label: "Tablet 768×1024" },
  { preset: "desktop", label: "Desktop 1280×800" },
  { preset: "reset", label: "Reset" },
];

function selectorFor(el: Element): string {
  const escape = (value: string) => CSS.escape(value);
  if (el.id) return `#${escape(el.id)}`;
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const classes = Array.from(current.classList).slice(0, 2);
    if (classes.length) part += classes.map((name) => `.${escape(name)}`).join("");
    const parent: Element | null = current.parentElement;
    if (parent && parent.querySelectorAll(`:scope > ${part}`).length > 1) part += `:nth-child(${Array.from(parent.children).indexOf(current) + 1})`;
    parts.unshift(part);
    if (parent?.tagName === "BODY") break;
    current = parent;
  }
  return parts.join(" > ");
}

function capture(el: PickElement): Capture {
  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  const styles: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  for (const key of STYLE_KEYS) styles[key] = computed[key] || "";
  for (const attr of Array.from(el.attributes).slice(0, 40)) attributes[attr.name] = attr.value.slice(0, 500);
  const text = (el.innerText || el.textContent || "").trim();
  return {
    page: { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, dpr: devicePixelRatio, capturedAt: new Date().toISOString() },
    target: {
      selector: selectorFor(el), tag: el.tagName, id: el.id || "", className: typeof el.className === "string" ? el.className : "", text: text.slice(0, 2_000), html: el.outerHTML.slice(0, 12_000), attributes,
      accessibility: { role: el.getAttribute("role") || "", label: el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "" },
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, pageBounds: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }, styles,
    },
    context: { parentText: (el.parentElement?.textContent || "").trim().slice(0, 1_000), previousText: (el.previousElementSibling?.textContent || "").trim().slice(0, 500), nextText: (el.nextElementSibling?.textContent || "").trim().slice(0, 500) },
  };
}

const panel: preact.JSX.CSSProperties = { position: "fixed", zIndex: 2_147_483_647, boxSizing: "border-box", color: "#e8e8e8", background: "#202124", border: "1px solid #4b4d51", borderRadius: "8px", boxShadow: "0 8px 28px rgba(0,0,0,.38)", font: "13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", pointerEvents: "auto" };

export function App({ bindingName, focusColor, restorePickMode }: DesignModeOverlayOptions) {
  const outline = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ capture: Capture; left: number; top: number } | null>(null);
  const [comment, setComment] = useState("");
  const [intent, setIntent] = useState<Intent>("change");
  const [annotations, setAnnotations] = useState<DesignModeAnnotation[]>([]);
  const [positions, setPositions] = useState<Record<number, { left: number; top: number } | null>>({});
  const [agentState, setAgentState] = useState<DesignModeAgentState>({ agents: [] });
  const [targetAgent, setTargetAgent] = useState("");
  const [sendState, setSendState] = useState<DesignModeSendState>({ status: "idle" });
  const [viewportState, setViewportState] = useState<DesignModeViewportState>({ preset: "reset", status: "idle" });

  const post = (value: unknown) => {
    const raw = JSON.stringify(value);
    const queue = window.__tachyonDmQueue = window.__tachyonDmQueue || [];
    queue.push(raw);
    try {
      const binding = window[bindingName as keyof Window];
      if (typeof binding === "function") (binding as (payload: string) => void)(raw);
    } catch { /* polling queue is the reliable fallback */ }
  };

  useEffect(() => {
    window.__tachyonDmApplyAnnotationState = (next) => { setAnnotations(next); return next.length; };
    window.__tachyonDmApplyAgentState = (next) => {
      setAgentState(next);
      setTargetAgent((current) => next.agents.includes(current) ? current : next.active && next.agents.includes(next.active) ? next.active : next.agents[0] || "");
      return next.agents.length;
    };
    window.__tachyonDmApplySendState = (next) => { setSendState(next); return next.status; };
    window.__tachyonDmApplyViewportState = (next) => { setViewportState(next); return next.preset; };
    post({ __annotation: "sync" });
    post({ __annotation: "agents" });
    post({ action: "viewport.sync" });
    return () => { delete window.__tachyonDmApplyAnnotationState; delete window.__tachyonDmApplyAgentState; delete window.__tachyonDmApplySendState; delete window.__tachyonDmApplyViewportState; };
  }, [bindingName]);

  useEffect(() => {
    let frame = 0;
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next: Record<number, { left: number; top: number } | null> = {};
        for (const annotation of annotations) {
          try {
            const el = document.querySelector(annotation.target.selector);
            if (!el) next[annotation.index] = null;
            else { const rect = el.getBoundingClientRect(); next[annotation.index] = { left: Math.max(4, rect.right - 10), top: Math.max(4, rect.top - 10) }; }
          } catch { next[annotation.index] = null; }
        }
        setPositions(next);
      });
    };
    reposition();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !(mutation.target instanceof Element) || !mutation.target.closest("[data-tachyon-dm-overlay]"))) reposition();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    addEventListener("scroll", reposition, true);
    addEventListener("resize", reposition);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("scroll", reposition, true); removeEventListener("resize", reposition); };
  }, [annotations]);

  useEffect(() => {
    let pickMode = restorePickMode;
    let hover: Element | null = null;
    const root = outline.current!;
    const clear = () => { hover = null; root.style.display = "none"; };
    const show = (el: Element) => { const rect = el.getBoundingClientRect(); hover = el; Object.assign(root.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); };
    const isOverlay = (el: Element | null) => !!el?.closest("[data-tachyon-dm-overlay]");
    const move = (event: MouseEvent) => { if (!pickMode || draft) return; const el = document.elementFromPoint(event.clientX, event.clientY); if (el && !isOverlay(el) && el !== hover) show(el); };
    const click = (event: MouseEvent) => {
      if (!pickMode || draft) return;
      const el = document.elementFromPoint(event.clientX, event.clientY) as PickElement | null;
      if (!el || isOverlay(el)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const rect = el.getBoundingClientRect();
      setDraft({ capture: capture(el), left: Math.min(Math.max(8, rect.left), innerWidth - Math.min(320, innerWidth - 16)), top: Math.min(rect.bottom + 8, innerHeight - 225) });
      setComment(""); setIntent("change"); clear();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { if (draft) setDraft(null); else { pickMode = false; clear(); } } };
    const nav = (event: Event) => { const target = event.target instanceof Element ? event.target : null; if (target?.closest("a[href],form") && !isOverlay(target)) post({ __layout: "internalNav" }); };
    window.__tachyonDmSetPickMode = (on: boolean) => { pickMode = !!on; if (!pickMode) { clear(); setDraft(null); } return pickMode; };
    document.addEventListener("mousemove", move, true); document.addEventListener("click", click, true); document.addEventListener("click", nav, true); document.addEventListener("submit", nav, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousemove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("click", nav, true); document.removeEventListener("submit", nav, true); document.removeEventListener("keydown", key, true); delete window.__tachyonDmSetPickMode; };
  }, [bindingName, restorePickMode, draft]);

  const add = () => { if (!draft || !comment.trim()) return; post({ __annotation: "add", intent, comment: comment.trim(), capture: draft.capture }); setDraft(null); setComment(""); };
  const send = () => { if (!targetAgent || sendState.status === "sending") return; setSendState({ status: "sending" }); post({ action: "annotation.send", targetAgent }); };
  const setViewport = (preset: DesignModeViewportPreset) => { setViewportState((current) => ({ ...current, status: "setting", text: undefined })); post({ action: "viewport.set", preset }); };

  return <div data-tachyon-dm-overlay>
    <div ref={outline} id="tachyon-dm-root" aria-hidden="true" style={{ position: "fixed", display: "none", pointerEvents: "none", zIndex: 2_147_483_646, border: `2px solid ${focusColor}`, boxSizing: "border-box", borderRadius: "2px" }} />
    {draft && <section data-tachyon-dm-overlay data-testid="annotation-popover" aria-label="Add annotation" style={{ ...panel, left: `${draft.left}px`, top: `${Math.max(8, draft.top)}px`, width: "min(320px, calc(100vw - 16px))", padding: "12px" }}>
      <strong style={{ display: "block", marginBottom: "8px" }}>Annotate {draft.capture.target.tag.toLowerCase()}</strong>
      <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
        {(["change", "question"] as const).map((value) => <button type="button" aria-pressed={intent === value} onClick={() => setIntent(value)} style={{ border: `1px solid ${intent === value ? focusColor : "#666"}`, color: "#fff", background: intent === value ? "#075985" : "#303136", borderRadius: "999px", padding: "4px 10px", cursor: "pointer" }}>{value === "change" ? "Change" : "Question"}</button>)}
      </div>
      <textarea aria-label="Annotation comment" autoFocus value={comment} onInput={(event) => setComment(event.currentTarget.value)} placeholder={intent === "change" ? "What should change?" : "What do you want to know?"} style={{ width: "100%", minHeight: "76px", resize: "vertical", boxSizing: "border-box", border: "1px solid #686a70", borderRadius: "5px", padding: "8px", color: "#fff", background: "#151619", font: "inherit" }} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}><button type="button" onClick={() => setDraft(null)} style={{ color: "#ddd", background: "transparent", border: 0, cursor: "pointer" }}>Cancel</button><button data-testid="annotation-add" type="button" disabled={!comment.trim()} onClick={add} style={{ color: "white", background: comment.trim() ? focusColor : "#555", border: 0, borderRadius: "5px", padding: "6px 12px", cursor: comment.trim() ? "pointer" : "default" }}>Add</button></div>
    </section>}
    {annotations.map((annotation) => positions[annotation.index] && <span data-tachyon-dm-overlay data-testid={`annotation-badge-${annotation.index}`} title={`Annotation ${annotation.index}`} style={{ position: "fixed", zIndex: 2_147_483_646, left: `${positions[annotation.index]!.left}px`, top: `${positions[annotation.index]!.top}px`, width: "22px", height: "22px", borderRadius: "50%", color: "white", background: focusColor, border: "2px solid white", boxShadow: "0 2px 7px rgba(0,0,0,.35)", font: "bold 12px/18px sans-serif", textAlign: "center", pointerEvents: "none", boxSizing: "border-box" }}>{annotation.index}</span>)}
    <nav data-tachyon-dm-overlay data-testid="viewport-toolbar" aria-label="Viewport presets" style={{ ...panel, left: "8px", bottom: "8px", display: "flex", flexWrap: "wrap", gap: "4px", maxWidth: "calc(100vw - 16px)", padding: "6px" }}>
      {VIEWPORT_PRESETS.map(({ preset, label }) => <button type="button" data-testid={`viewport-${preset}`} aria-pressed={viewportState.preset === preset} disabled={viewportState.status === "setting"} onClick={() => setViewport(preset)} style={{ color: "#fff", background: viewportState.preset === preset ? focusColor : "#303136", border: "1px solid #686a70", borderRadius: "5px", padding: "5px 8px", cursor: "pointer", font: "inherit" }}>{label}</button>)}
      {viewportState.status === "error" && <span role="status" style={{ color: "#fca5a5", alignSelf: "center" }}>{viewportState.text}</span>}
    </nav>
    {annotations.length > 0 && <aside data-tachyon-dm-overlay data-testid="annotation-tray" aria-label="Annotations" style={{ ...panel, right: "8px", bottom: "110px", width: "min(380px, calc(100vw - 16px))", maxHeight: "min(45vh, 360px)", overflow: "auto" }}>
      <header style={{ padding: "10px 12px", borderBottom: "1px solid #45464a", display: "flex", justifyContent: "space-between" }}><strong>Annotations</strong><span style={{ color: "#aaa" }}>{annotations.length}</span></header>
      {annotations.map((annotation) => <article data-testid={`annotation-row-${annotation.index}`} style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr) 28px", gap: "8px", padding: "10px 12px", borderBottom: "1px solid #3b3c40" }}>
        <span style={{ width: "24px", height: "24px", borderRadius: "50%", background: focusColor, color: "white", textAlign: "center", fontWeight: 700, lineHeight: "24px" }}>{annotation.index}</span>
        <div style={{ minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: "6px" }}><code style={{ color: "#d0d0d0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{annotation.target.tag.toLowerCase()}{annotation.target.id ? `#${annotation.target.id}` : ""}</code><small style={{ color: annotation.intent === "question" ? "#c4b5fd" : "#7dd3fc", textTransform: "capitalize" }}>{annotation.intent}</small></div>{annotation.screenshotPreview && <img data-testid={`annotation-preview-${annotation.index}`} src={annotation.screenshotPreview} alt={`Screenshot preview for annotation ${annotation.index}`} style={{ display: "block", width: "100%", maxHeight: "112px", margin: "6px 0", objectFit: "contain", objectPosition: "left center", borderRadius: "4px", background: "#111" }} />}<div style={{ color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{annotation.target.text || annotation.target.selector}</div><div style={{ marginTop: "3px", overflowWrap: "anywhere" }}>{annotation.comment}</div>{positions[annotation.index] === null && <div role="status" style={{ color: "#fbbf24", marginTop: "4px" }}>Target not found</div>}</div>
        <button type="button" aria-label={`Delete annotation ${annotation.index}`} onClick={() => post({ __annotation: "delete", index: annotation.index })} style={{ alignSelf: "start", color: "#ccc", background: "transparent", border: 0, fontSize: "18px", cursor: "pointer" }}>×</button>
      </article>)}
      <footer style={{ padding: "10px 12px", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: "8px", alignItems: "center" }}>
        <select data-testid="annotation-agent-select" aria-label="Send annotations to agent" value={targetAgent} onChange={(event) => setTargetAgent(event.currentTarget.value)} disabled={!agentState.agents.length || sendState.status === "sending"} style={{ minWidth: 0, color: "#fff", background: "#303136", border: "1px solid #686a70", borderRadius: "5px", padding: "6px 8px", font: "inherit" }}>
          {!agentState.agents.length && <option value="">No agent available</option>}
          {agentState.agents.map((agent) => <option value={agent}>{agent}</option>)}
        </select>
        <button type="button" aria-label="Clear annotations" onClick={() => post({ action: "annotation.clear" })} disabled={sendState.status === "sending"} style={{ color: "#ddd", background: "transparent", border: "1px solid #686a70", borderRadius: "5px", padding: "6px 8px", cursor: "pointer" }}>Clear</button>
        <button data-testid="annotation-send" type="button" disabled={!targetAgent || sendState.status === "sending"} onClick={send} style={{ color: "white", background: targetAgent ? focusColor : "#555", border: 0, borderRadius: "5px", padding: "7px 14px", cursor: targetAgent ? "pointer" : "default" }}>{sendState.status === "sending" ? "Sending…" : "Send"}</button>
        {(sendState.text || agentState.emptyReason) && <div role="status" style={{ gridColumn: "1 / -1", color: sendState.status === "error" ? "#fca5a5" : "#bbb", overflowWrap: "anywhere" }}>{sendState.text || agentState.emptyReason}</div>}
      </footer>
    </aside>}
  </div>;
}

declare global {
  interface Window {
    __tachyonDmQueue?: string[];
    __tachyonDmSetPickMode?: (on: boolean) => boolean;
    __tachyonDmApplyAnnotationState?: (annotations: DesignModeAnnotation[]) => number;
    __tachyonDmApplyAgentState?: (state: DesignModeAgentState) => number;
    __tachyonDmApplySendState?: (state: DesignModeSendState) => string;
    __tachyonDmApplyViewportState?: (state: DesignModeViewportState) => DesignModeViewportPreset;
  }
}
