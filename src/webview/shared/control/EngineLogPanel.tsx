import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ControlInspectorWorkspaceRow } from "../../../control-inspector/model";
import { Button, Input, Select } from "../ui";
import type { EngineAction } from "../../engine/messages";

export type LogSource = "daemon" | "events" | "bridge";
type Since = "all" | "2m" | "15m";

const HIGHLIGHTS = ["error", "ERROR", "orphan", "Bridge", "wedged", "t-8310ca"] as const;

function parseLevel(line: string): "I" | "W" | "E" | "D" | "?" {
  // ISO… I msg
  const m = line.match(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+([IWED])\s/);
  return (m?.[1] as "I" | "W" | "E" | "D") ?? "?";
}

function lineTimeMs(line: string): number | undefined {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/);
  if (!m) return undefined;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : undefined;
}

function levelClass(level: string): string {
  if (level === "E") return "ci-log-line lvl-e";
  if (level === "W") return "ci-log-line lvl-w";
  if (level === "D") return "ci-log-line lvl-d";
  return "ci-log-line lvl-i";
}

function highlightClass(line: string): string {
  for (const h of HIGHLIGHTS) {
    if (line.includes(h)) return " hi";
  }
  return "";
}

function sourceLines(row: ControlInspectorWorkspaceRow, source: LogSource): string[] {
  const by = row.engine.logBySource;
  if (source === "daemon") return by?.daemon ?? row.engine.logTail ?? [];
  if (source === "events") return by?.events ?? [];
  return by?.bridge ?? [];
}

export function EngineLogPanel({
  row,
  post,
}: {
  row: ControlInspectorWorkspaceRow;
  post: (a: EngineAction) => void;
}) {
  const [source, setSource] = useState<LogSource>("daemon");
  const [filter, setFilter] = useState("");
  const [since, setSince] = useState<Since>("all");
  const [paused, setPaused] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stickBottom = useRef(true);

  const raw = sourceLines(row, source);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const now = Date.now();
    const sinceMs = since === "2m" ? 2 * 60_000 : since === "15m" ? 15 * 60_000 : 0;
    return raw.filter((line) => {
      if (q && !line.toLowerCase().includes(q)) return false;
      if (sinceMs > 0) {
        const t = lineTimeMs(line);
        if (t !== undefined && now - t > sinceMs) return false;
      }
      return true;
    });
  }, [raw, filter, since]);

  useEffect(() => {
    const el = preRef.current;
    if (!el || paused || !stickBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, paused]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickBottom.current = atBottom;
    setPaused(!atBottom);
  };

  const empty =
    source === "bridge"
      ? "Bridge log not available yet."
      : source === "events"
        ? "No recent control-plane events."
        : "No recent engine log.";

  return (
    <div class="ci-log">
      <div class="ci-log-toolbar">
        <div class="ci-log-label">
          Recent log
          {row.engine.logHasError ? <span class="ci-log-err-badge" title="Errors in daemon ring">err</span> : null}
          {paused ? <span class="ci-log-paused">paused</span> : null}
        </div>
        <div class="ci-log-actions">
          <div class="ci-log-sources" role="tablist" aria-label="Log source">
            {(["daemon", "events", "bridge"] as const).map((s) => (
              <button
                type="button"
                class={`ci-log-src${source === s ? " on" : ""}`}
                role="tab"
                aria-selected={source === s}
                onClick={() => setSource(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <Input
            class="ci-log-filter"
            type="search"
            placeholder="Filter…"
            value={filter}
            onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          />
          <Select
            class="ci-log-since"
            value={since}
            onChange={(e) => setSince((e.currentTarget as HTMLSelectElement).value as Since)}
            aria-label="Time window"
          >
            <option value="all">All</option>
            <option value="2m">2m</option>
            <option value="15m">15m</option>
          </Select>
          <Button
            variant="default"
            disabled={filtered.length === 0}
            onClick={() => post({ type: "copyText", text: filtered.join("\n") })}
          >
            Copy
          </Button>
          <Button
            variant="default"
            disabled={source !== "daemon"}
            title={source !== "daemon" ? "Clear applies to daemon ring only" : "Clear daemon ring"}
            onClick={() => post({ type: "engineLogClear", wsHash: row.wsHash })}
          >
            Clear
          </Button>
          <Button variant="default" onClick={() => post({ type: "engineLogJournal", wsHash: row.wsHash })}>
            Journal
          </Button>
        </div>
      </div>
      {filtered.length > 0 ? (
        <pre
          class="ci-log-pre"
          ref={preRef}
          onScroll={onScroll}
          aria-label="Recent engine log"
        >
          {filtered.map((line, i) => {
            const lvl = parseLevel(line);
            return (
              <span key={i} class={levelClass(lvl) + highlightClass(line)}>
                {line}
                {"\n"}
              </span>
            );
          })}
        </pre>
      ) : (
        <div class="ci-log-empty">{empty}</div>
      )}
    </div>
  );
}
