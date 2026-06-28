import type { InspectorModel, InspectorSession } from "../../inspector/model";
import type { InspectorStrings } from "./messages";

// spec 279 — the Inspector view (converted from ServerInspector's inline <script>). Renders the engine's
// InspectorModel with l10n strings; relays capture/kill/open/reap/refresh as inbound actions. preact escapes
// text by default (the old inline path hand-escaped every field).

function ago(s: InspectorStrings, epochSec?: number): string {
  if (!epochSec) return "";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (sec < 60) return s.ageSeconds.replace("{0}", String(sec));
  if (sec < 3600) return s.ageMinutes.replace("{0}", String(Math.floor(sec / 60)));
  if (sec < 86400) return s.ageHours.replace("{0}", String(Math.floor(sec / 3600)));
  return s.ageDays.replace("{0}", String(Math.floor(sec / 86400)));
}

function Badge({ s, sess }: { s: InspectorStrings; sess: InspectorSession }) {
  if (!sess.dead) return <span class="badge live"><span class="codicon codicon-pulse" />{s.live}</span>;
  const crashed = typeof sess.exitCode === "number" && sess.exitCode !== 0;
  const label = typeof sess.exitCode === "number" ? s.exit.replace("{0}", String(sess.exitCode)) : s.dead;
  return <span class={`badge ${crashed ? "crashed" : "dead"}`}>{label}</span>;
}

const kindLabel = (s: InspectorStrings, kind: InspectorSession["kind"]): string =>
  ({ session: s.kindSession, command: s.kindCommand, runbook: s.kindRunbook, anchor: s.kindAnchor, unknown: s.kindUnknown }[kind] ?? kind);

export interface InspectorAppProps {
  model: InspectorModel | undefined;
  strings: InspectorStrings | undefined;
  /** captured pane text by session (only rendered when the session is in `open`). */
  captures: Record<string, string>;
  open: ReadonlySet<string>;
  auto: boolean;
  onToggleAuto: (on: boolean) => void;
  onToggleCapture: (session: string) => void;
  onAction: (a: { type: "refresh" | "reapDead" | "reapOrphans" } | { type: "open" | "kill"; session: string }) => void;
}

export function App(p: InspectorAppProps) {
  const s = p.strings;
  if (!s) return <div class="ds-empty" />; // the host posts init on ready
  const model = p.model;
  return (
    <>
      <div class="head">
        <h2 class="ds-title"><span class="codicon codicon-server-process" />{s.title}</h2>
      </div>
      <p class="ds-sub">{s.subtitle}</p>
      <div class="toolbar">
        <span class="summary">{model ? s.summary.replace("{0}", String(model.totalSessions)).replace("{1}", String(model.liveSessions)) : ""}</span>
        {model && model.orphanSessions > 0 && (
          <button class="ds-btn danger" onClick={() => p.onAction({ type: "reapOrphans" })}><span class="codicon codicon-database" />{s.reapOrphans.replace("{0}", String(model.orphanSessions))}</button>
        )}
        {model && model.deadSessions > 0 && (
          <button class="ds-btn danger" onClick={() => p.onAction({ type: "reapDead" })}><span class="codicon codicon-trash" />{s.reapDead.replace("{0}", String(model.deadSessions))}</button>
        )}
        <label class="auto"><input type="checkbox" checked={p.auto} onChange={(e) => p.onToggleAuto((e.target as HTMLInputElement).checked)} />{s.auto}</label>
        <button class="ds-btn" onClick={() => p.onAction({ type: "refresh" })}><span class="codicon codicon-refresh" />{s.refresh}</button>
      </div>
      <div id="body">
        {!model || model.groups.length === 0 ? (
          <div class="ds-empty">{s.empty}</div>
        ) : (
          model.groups.map((g, gi) => {
            let lastKind: InspectorSession["kind"] | null = null;
            return (
              <div class="group" key={g.wsHash ?? `g${gi}`}>
                <div class="ws">
                  <span>{g.workspace}</span>
                  {g.wsHash && <span class="hash">{g.wsHash}</span>}
                  {g.foreign && <span class="foreign">{s.foreignNote}</span>}
                </div>
                {g.sessions.map((sess) => {
                  const showKind = sess.kind !== lastKind;
                  lastKind = sess.kind;
                  const meta = `${s.pid} ${sess.pid}${sess.currentCommand ? ` · ${sess.currentCommand}` : ""}`;
                  const age = ago(s, sess.createdAt);
                  return (
                    <>
                      {showKind && <div class="kind" key={`k-${sess.session}`}>{kindLabel(s, sess.kind)}</div>}
                      <div class="sess" data-session={sess.session} key={sess.session}>
                        <Badge s={s} sess={sess} />
                        {sess.cpu && <span class={`cpu ${sess.cpu}`}>{sess.cpu === "busy" ? s.busy : s.idle}</span>}
                        <span class="name">{sess.label}</span>
                        <span class="meta">{meta}</span>
                        {age && <span class="age">{age}</span>}
                        <span class="acts">
                          <button class="open ds-btn" onClick={() => p.onAction({ type: "open", session: sess.session })}><span class="codicon codicon-link-external" />{s.open}</button>
                          <button class="cap ds-btn" onClick={() => p.onToggleCapture(sess.session)}><span class="codicon codicon-output" />{s.capture}</button>
                          <button class="kill danger ds-btn" onClick={() => p.onAction({ type: "kill", session: sess.session })}><span class="codicon codicon-trash" />{s.kill}</button>
                        </span>
                      </div>
                      {p.open.has(sess.session) && (
                        <pre class="cap" key={`cap-${sess.session}`}>{p.captures[sess.session] && p.captures[sess.session].length > 0 ? p.captures[sess.session] : s.captureEmpty}</pre>
                      )}
                    </>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
