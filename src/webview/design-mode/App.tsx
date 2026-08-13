import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DesignModeEvent, DesignModeWebviewMessage, ResponsivePreset } from "./messages.js";
import { READY } from "./messages.js";
declare const acquireVsCodeApi: undefined | (() => { postMessage(message: DesignModeWebviewMessage): void });
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
const post = (message: DesignModeWebviewMessage) => vscode?.postMessage(message);
type ChatEvent = { lineNo?: number; kind?: string; role?: string; agent?: string; text?: string; delivery?: string };
type Selection = { summary: string; tag?: string; selectorHint?: string; text?: string };
const VIEWPORTS: Array<{ preset: ResponsivePreset; label: string; size: string; icon: string }> = [
  { preset: "phone", label: "Phone", size: "375 × 812", icon: "codicon-device-mobile" },
  { preset: "tablet", label: "Tablet", size: "768 × 1024", icon: "codicon-device-tablet" },
  { preset: "desktop", label: "Desktop", size: "1280 × 800", icon: "codicon-device-desktop" },
  { preset: "reset", label: "Reset", size: "Native", icon: "codicon-discard" },
];

export function App() {
  const [events, setEvents] = useState<ChatEvent[]>([]), [agents, setAgents] = useState<string[]>([]);
  const [active, setActive] = useState("agent"), [emptyReason, setEmptyReason] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null), [pickMode, setPickMode] = useState(true), [viewport, setViewport] = useState<ResponsivePreset>("reset");
  const [working, setWorking] = useState(""), [error, setError] = useState(""), [hasMore, setHasMore] = useState(false), [draft, setDraft] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const receive = (message: MessageEvent<{ type?: string; event?: DesignModeEvent }>) => {
      if (message.data?.type !== "designMode.event" || !message.data.event) return;
      const e = message.data.event;
      if (e.type === "snapshot") { setAgents(e.agents as string[]); setActive(String(e.active)); setSelection(e.selection as Selection); setEvents(e.items as ChatEvent[]); setHasMore(true); }
      else if (e.type === "agents") { setAgents(Array.isArray(e.agents) ? e.agents.filter((x): x is string => typeof x === "string") : []); if (typeof e.active === "string") setActive(e.active); setEmptyReason(typeof e.emptyReason === "string" ? e.emptyReason : ""); }
      else if (e.type === "selection") { if (e.clear) setSelection(null); else if (e.attached && typeof e.summary === "string") setSelection(e as unknown as Selection); }
      else if (e.type === "chunk") { const items = Array.isArray(e.items) ? e.items as ChatEvent[] : []; setEvents((old) => e.mode === "before" ? [...items, ...old] : items); setHasMore(e.hasMoreBefore === true); }
      else if (e.type === "message" || e.type === "system" || e.type === "agent_switch") { if (e.event && typeof e.event === "object") setEvents((old) => [...old, e.event as ChatEvent]); }
      else if (e.type === "working") setWorking(e.on ? `${String(e.agent ?? active)} · ${String(e.phase ?? "working")}` : "");
      else if (e.type === "error") setError(String(e.text ?? "Design Mode error"));
    };
    window.addEventListener("message", receive); post({ type: READY }); return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [events.length]);
  const oldest = useMemo(() => events.find((e) => typeof e.lineNo === "number")?.lineNo, [events]);
  const send = () => { const text = draft.trim(); if (text) { post({ type: "designMode.send", text }); setDraft(""); setError(""); } };
  const chooseViewport = (preset: ResponsivePreset) => { setViewport(preset); post({ __layout: "responsive", preset }); };
  const activeViewport = VIEWPORTS.find((item) => item.preset === viewport) ?? VIEWPORTS[3];
  return <main class="dm-app">
    <header class="dm-header"><div><div class="dm-eyebrow">Integrated Browser</div><h1>Design Mode</h1></div><label class="dm-picker"><input type="checkbox" checked={pickMode} onChange={(e) => { const on = e.currentTarget.checked; setPickMode(on); post({ type: "designMode.pickMode", on }); }} /> Pick elements</label></header>
    <section class="dm-viewport" aria-label="Browser viewport"><div class="dm-viewport-heading"><span>Viewport</span><output aria-live="polite">Active: {activeViewport.label} · {activeViewport.size}</output></div><div class="dm-viewport-options">{VIEWPORTS.map((item) => <button key={item.preset} class={`ds-btn ds-btn-secondary${viewport === item.preset ? " is-active" : ""}`} aria-pressed={viewport === item.preset} title={`${item.label} · ${item.size}`} onClick={() => chooseViewport(item.preset)}><span class={`codicon ${item.icon}`} aria-hidden="true" /><span class="dm-viewport-label">{item.label}</span><span class="dm-viewport-size">{item.size}</span></button>)}</div></section>
    <section class="dm-agent-row" aria-label="Active agent"><span class="codicon codicon-hubot" aria-hidden="true" /><select class="ds-input" value={active} disabled={!agents.length} onChange={(e) => post({ type: "designMode.agent", agent: e.currentTarget.value })}>{!agents.length && <option>{active}</option>}{agents.map((agent) => <option value={agent}>{agent}</option>)}</select><button class="ds-btn ds-btn-secondary" onClick={() => post({ type: "designMode.openTerminal" })}>Open terminal</button></section>
    {emptyReason && <p class="dm-notice">{emptyReason}</p>}
    {selection && <aside class="dm-selection" aria-label="Attached selection"><div class="dm-selection-title"><span>Attached selection</span><button class="icon" aria-label="Clear selection" onClick={() => post({ type: "designMode.clearSelection" })}>×</button></div><code>{selection.summary}</code>{selection.text && <p>{selection.text}</p>}</aside>}
    <section class="dm-thread" aria-label="Design Mode chat">{hasMore && oldest && <button class="ds-btn ds-btn-secondary dm-load" onClick={() => post({ type: "designMode.loadBefore", before: oldest })}>Load earlier</button>}<div class="dm-scroll" ref={scroll}>{!events.length && <div class="dm-empty"><span class="codicon codicon-comment-discussion" /><p>Point at the page, then tell {active} what should change.</p></div>}{events.map((event, i) => <article class={`dm-message dm-${event.role ?? event.kind ?? "system"}`} key={`${event.lineNo ?? i}`}><div class="dm-speaker">{event.role === "user" ? "You" : event.agent ?? (event.kind === "system" ? "Design Mode" : active)}</div><div class="dm-text">{event.text}</div>{event.delivery === "pending" && <span class="dm-delivery">sending…</span>}</article>)}{working && <div class="dm-working"><i /><i /><i /> {working}</div>}</div></section>
    {error && <div class="dm-error" role="alert">{error}</div>}
    <footer class="dm-compose"><textarea class="ds-input" value={draft} rows={3} placeholder={`Message ${active}…`} onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} /><button class="ds-btn" disabled={!draft.trim()} onClick={send}>Send</button></footer>
  </main>;
}
