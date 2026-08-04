import { useMemo, useState } from "preact/hooks";
import type { InspectorGroup, InspectorModel, InspectorSession } from "../../inspector/model";
import type { InspectorStrings } from "./messages";
import { Badge, Button, EmptyState, Input, PageChrome, Select, Tabs } from "../shared/ui";

function ageSeconds(epochSec?: number): number | undefined {
  return epochSec ? Math.max(0, Math.floor(Date.now() / 1000 - epochSec)) : undefined;
}

function ago(s: InspectorStrings, epochSec?: number): string {
  const sec = ageSeconds(epochSec);
  if (sec === undefined) return "";
  if (sec < 60) return s.ageSeconds.replace("{0}", String(sec));
  if (sec < 3600) return s.ageMinutes.replace("{0}", String(Math.floor(sec / 60)));
  if (sec < 86400) return s.ageHours.replace("{0}", String(Math.floor(sec / 3600)));
  return s.ageDays.replace("{0}", String(Math.floor(sec / 86400)));
}

function SessionStatus({ s, sess }: { s: InspectorStrings; sess: InspectorSession }) {
  if (!sess.dead) {
    return (
      <Badge tone="ok">
        <span class="codicon codicon-pulse" aria-hidden="true" /> {s.live}
      </Badge>
    );
  }
  const crashed = typeof sess.exitCode === "number" && sess.exitCode !== 0;
  const label = typeof sess.exitCode === "number" ? s.exit.replace("{0}", String(sess.exitCode)) : s.dead;
  return <Badge tone={crashed ? "err" : "default"}>{label}</Badge>;
}

const kindLabel = (s: InspectorStrings, kind: InspectorSession["kind"]): string =>
  ({ session: s.kindSession, command: s.kindCommand, runbook: s.kindRunbook, anchor: s.kindAnchor, unknown: s.kindUnknown }[kind] ?? kind);

type Action = { type: "refresh" | "reapDead" | "reapOrphans" } | { type: "open" | "kill"; session: string };

export interface InspectorAppProps {
  model: InspectorModel | undefined;
  strings: InspectorStrings | undefined;
  captures: Record<string, string>;
  open: ReadonlySet<string>;
  auto: boolean;
  onToggleAuto: (on: boolean) => void;
  onToggleCapture: (session: string) => void;
  onCloseCapture: (session: string) => void;
  onAction: (a: Action) => void;
}

export function App(p: InspectorAppProps) {
  const s = p.strings;
  const [tab, setTab] = useState<"overview" | "server">("overview");
  const [search, setSearch] = useState("");
  const [workspace, setWorkspace] = useState("all");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [cpu, setCpu] = useState("all");
  const [details, setDetails] = useState<Set<string>>(new Set());
  const model = p.model;

  const groups = useMemo(() => {
    if (!model) return [];
    const needle = search.trim().toLocaleLowerCase();
    return model.groups.flatMap((group): InspectorGroup[] => {
      if (workspace !== "all" && (group.wsHash ?? "unscoped") !== workspace) return [];
      const sessions = group.sessions.filter((session) => {
        if (status === "live" && session.dead) return false;
        if (status === "dead" && !session.dead) return false;
        if (kind !== "all" && session.kind !== kind) return false;
        if (cpu !== "all" && session.cpu !== cpu) return false;
        if (
          needle &&
          ![session.session, session.label, session.currentCommand, session.startCommand].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          )
        ) {
          return false;
        }
        return true;
      });
      return sessions.length ? [{ ...group, sessions }] : [];
    });
  }, [model, search, workspace, status, kind, cpu]);

  if (!s) return <EmptyState kind="empty" message="" />;
  const toggleDetails = (session: string) =>
    setDetails((previous) => {
      const next = new Set(previous);
      if (next.has(session)) next.delete(session);
      else next.add(session);
      return next;
    });

  return (
    <div class="insp-root ds-page">
      <PageChrome
        title={s.title}
        hint={s.subtitle}
        actions={
          <div class="insp-toolbar">
            <span class="summary">
              {model ? s.summary.replace("{0}", String(model.totalSessions)).replace("{1}", String(model.liveSessions)) : ""}
            </span>
            <label class="auto">
              <input type="checkbox" checked={p.auto} onChange={(e) => p.onToggleAuto((e.target as HTMLInputElement).checked)} />
              {s.auto}
            </label>
            <Button icon="refresh" onClick={() => p.onAction({ type: "refresh" })}>
              {s.refresh}
            </Button>
          </div>
        }
      />
      <Tabs
        items={[
          { id: "overview", label: s.overview },
          { id: "server", label: s.server },
        ]}
        active={tab}
        onSelect={(id) => setTab(id as "overview" | "server")}
      />

      {tab === "server" ? (
        <section class="server-panel">
          <div class="summary-grid">
            {(
              [
                [s.total, model?.totalSessions ?? 0],
                [s.live, model?.liveSessions ?? 0],
                [s.dead, model?.deadSessions ?? 0],
                [s.orphaned, model?.orphanSessions ?? 0],
                [s.busy, model?.busySessions ?? 0],
              ] as const
            ).map(([label, value]) => (
              <div class="metric" key={String(label)}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <dl class="server-facts">
            <dt>{s.health}</dt>
            <dd>
              <span class={`health ${model?.server?.state ?? "unknown"}`}>{model?.server?.state ?? "unknown"}</span>
            </dd>
            <dt>{s.socket}</dt>
            <dd>
              <code>{model?.server?.socketName ?? "tachyon"}</code>
            </dd>
            <dt>{s.path}</dt>
            <dd>
              <code>{model?.server?.socketPath ?? "—"}</code>
            </dd>
            <dt>{s.version}</dt>
            <dd>{model?.server?.tmuxVersion ?? "—"}</dd>
            <dt>{s.serverPids}</dt>
            <dd>{model?.server?.pids.join(", ") || "—"}</dd>
          </dl>
          <h3>{s.diagnostics}</h3>
          <pre class="diagnostics">{model?.server?.diagnostics || s.noDiagnostics}</pre>
          <div class="bulk">
            <strong>{s.bulkActions}</strong>
            <Button
              variant="danger"
              icon="database"
              disabled={!model?.orphanSessions}
              onClick={() => p.onAction({ type: "reapOrphans" })}
            >
              {s.reapOrphans.replace("{0}", String(model?.orphanSessions ?? 0))}
            </Button>
            <Button variant="danger" icon="trash" disabled={!model?.deadSessions} onClick={() => p.onAction({ type: "reapDead" })}>
              {s.reapDead.replace("{0}", String(model?.deadSessions ?? 0))}
            </Button>
          </div>
        </section>
      ) : (
        <>
          <div class="filters">
            <Input aria-label={s.search} placeholder={s.search} value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
            <Select aria-label={s.workspace} value={workspace} onChange={(e) => setWorkspace((e.target as HTMLSelectElement).value)}>
              <option value="all">
                {s.workspace}: {s.all}
              </option>
              {model?.groups.map((g) => (
                <option value={g.wsHash ?? "unscoped"} key={g.wsHash ?? g.workspace}>
                  {g.workspace}
                </option>
              ))}
            </Select>
            <Select aria-label={s.status} value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
              <option value="all">
                {s.status}: {s.all}
              </option>
              <option value="live">{s.live}</option>
              <option value="dead">{s.dead}</option>
            </Select>
            <Select aria-label={s.kind} value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)}>
              <option value="all">
                {s.kind}: {s.all}
              </option>
              {(["session", "command", "runbook", "anchor", "unknown"] as const).map((k) => (
                <option value={k} key={k}>
                  {kindLabel(s, k)}
                </option>
              ))}
            </Select>
            <Select aria-label={s.cpu} value={cpu} onChange={(e) => setCpu((e.target as HTMLSelectElement).value)}>
              <option value="all">
                {s.cpu}: {s.all}
              </option>
              <option value="busy">{s.busy}</option>
              <option value="idle">{s.idle}</option>
            </Select>
          </div>
          <div id="body">
            {!model || groups.length === 0 ? (
              <EmptyState kind="empty" message={s.empty} />
            ) : (
              groups.map((g, gi) => (
                <div class="group" key={g.wsHash ?? `g${gi}`}>
                  <div class="ws">
                    <span>{g.workspace}</span>
                    {g.wsHash && <span class="hash">{g.wsHash}</span>}
                    {g.foreign && <span class="foreign">{s.foreignNote}</span>}
                  </div>
                  {g.sessions.map((sess) => {
                    const age = ago(s, sess.createdAt);
                    return (
                      <div class="session-block" key={sess.session}>
                        <div class="sess" data-session={sess.session}>
                          <SessionStatus s={s} sess={sess} />
                          {sess.cpu && <span class={`cpu ${sess.cpu}`}>{sess.cpu === "busy" ? s.busy : s.idle}</span>}
                          <span class="identity">
                            <strong>{sess.label}</strong>
                            <small>{kindLabel(s, sess.kind)}</small>
                          </span>
                          <span class="meta">
                            {s.pid} {sess.pid}
                            {sess.currentCommand ? ` · ${sess.currentCommand}` : ""}
                          </span>
                          {age && <span class="age">{age}</span>}
                          <span class="acts">
                            <Button icon="info" onClick={() => toggleDetails(sess.session)}>
                              {s.details}
                            </Button>
                            <Button icon="link-external" onClick={() => p.onAction({ type: "open", session: sess.session })}>
                              {s.open}
                            </Button>
                            <Button icon="output" onClick={() => p.onToggleCapture(sess.session)}>
                              {p.open.has(sess.session) ? s.refreshCapture : s.capture}
                            </Button>
                            <Button variant="danger" icon="trash" onClick={() => p.onAction({ type: "kill", session: sess.session })}>
                              {s.kill}
                            </Button>
                          </span>
                        </div>
                        {details.has(sess.session) && (
                          <dl class="session-details">
                            <dt>{s.fullName}</dt>
                            <dd>
                              <code>{sess.session}</code>
                            </dd>
                            <dt>{s.pid}</dt>
                            <dd>{sess.pid}</dd>
                            <dt>{s.kind}</dt>
                            <dd>{kindLabel(s, sess.kind)}</dd>
                            <dt>{s.hash}</dt>
                            <dd>{g.wsHash ?? "—"}</dd>
                            <dt>{s.command}</dt>
                            <dd>
                              <code>{sess.currentCommand || "—"}</code>
                            </dd>
                            <dt>{s.startCommand}</dt>
                            <dd>
                              <code>{sess.startCommand || "—"}</code>
                            </dd>
                            <dt>{s.uptime}</dt>
                            <dd>{age || "—"}</dd>
                            <dt>{s.status}</dt>
                            <dd>
                              {sess.dead
                                ? sess.exitCode === undefined
                                  ? s.dead
                                  : s.exit.replace("{0}", String(sess.exitCode))
                                : s.live}
                            </dd>
                          </dl>
                        )}
                        {p.open.has(sess.session) && (
                          <div class="capture-wrap">
                            <Button icon="close" onClick={() => p.onCloseCapture(sess.session)}>
                              {s.close}
                            </Button>
                            <pre class="cap">{p.captures[sess.session]?.length ? p.captures[sess.session] : s.captureEmpty}</pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
