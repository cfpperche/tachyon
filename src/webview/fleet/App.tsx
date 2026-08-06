/**
 * t-41117e — Fleet editor tab.
 * Same AgentsRoster + nine statuses as the sidebar. Do not reintroduce a boolean running/stopped list.
 */
import { useState } from "preact/hooks";
import type { FleetVM } from "../../sidebar/types";
import type { ActionId } from "../../sidebar/actions";
import { asSortMode, type SortMode } from "../../sidebar/sortRows";
import { Button, EmptyState, PageChrome } from "../shared/ui";
import {
  AgentsRoster,
  DispatchCtx,
  MoreMenu,
  type MenuItem,
} from "../sidebar/App";
import {
  ContinuePicker,
  defaultContinuePickerStrings,
  type ContinuePickerStrings,
} from "../shared/agents/ContinuePicker";
import type { FleetAction } from "./messages";

export type Strings = ContinuePickerStrings & {
  fleetTitle: string;
  fleetHint: string;
  openMissionControl: string;
  noneListed: string;
};

export const defaultStrings: Strings = {
  ...defaultContinuePickerStrings,
  fleetTitle: "Fleet",
  fleetHint: "Agents (runtime) — same roster as the sidebar, with nine statuses. Work items are on the Board.",
  openMissionControl: "Open Board",
  noneListed: "Nothing listed yet.",
};

type MenuState = { items: MenuItem[]; x: number; y: number } | null;

export function App({
  fleet,
  strings: s,
  post,
}: {
  fleet?: FleetVM;
  strings: Strings;
  post: (a: FleetAction) => void;
}) {
  // SDD 485 D7 — per-panel state. A module slot would let project B replace project A's picker.
  const [continuePick, setContinuePick] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [metricsOpen, setMetricsOpen] = useState<Set<string>>(() => new Set());
  const agentSort: SortMode = asSortMode("name-asc");
  const scope = fleet?.folder?.hash ?? "";
  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const onToggleMetrics = (name: string) => {
    const key = `${scope}:m:${name}`;
    setMetricsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const ctx = {
    action: (id: ActionId, agent: string) => {
      if (id === "continueTask") {
        setContinuePick(agent);
        return;
      }
      post({ type: "action", id, agent });
    },
    section: () => {},
    global: () => {},
    pipeline: () => {},
    openMore: (items: MenuItem[], x: number, y: number) => setMenu({ items, x, y }),
  };

  const folderLabel = fleet?.folder?.name;
  const hashLabel = fleet?.folder?.hash ? fleet.folder.hash.slice(0, 8) : undefined;

  return (
    <main class="ds-page fleet-tab" data-testid="control-fleet">
      <PageChrome
        title={s.fleetTitle}
        hint={s.fleetHint}
        actions={<Button variant="primary" onClick={() => post({ type: "openBoard" })}>{s.openMissionControl}</Button>}
      />
      {(folderLabel || hashLabel) ? (
        <p class="fleet-project-meta" data-testid="fleet-project-meta">
          {folderLabel ? <span class="fleet-folder">{folderLabel}</span> : null}
          {hashLabel ? <span class="ck-mono fleet-ws">{hashLabel}</span> : null}
        </p>
      ) : null}
      {!fleet ? (
        <EmptyState kind="empty" message={s.noneListed} />
      ) : (
        <DispatchCtx.Provider value={ctx}>
          <div class="fleet-agents-shell">
            <AgentsRoster
              fleet={fleet}
              scope={scope}
              collapsed={collapsed}
              toggle={toggle}
              flashName={null}
              agentSort={agentSort}
              metricsOpen={metricsOpen}
              onToggleMetrics={onToggleMetrics}
            />
          </div>
          <MoreMenu menu={menu} onClose={() => setMenu(null)} />
          {continuePick ? (
            <ContinuePicker
              agents={fleet.agents}
              fromName={continuePick}
              strings={s}
              onClose={() => setContinuePick(null)}
              onSelect={(toName) => {
                const from = continuePick;
                setContinuePick(null);
                post({ type: "continueTask", fromName: from, toName });
              }}
            />
          ) : null}
        </DispatchCtx.Provider>
      )}
    </main>
  );
}
