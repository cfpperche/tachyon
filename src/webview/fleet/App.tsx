import { useState } from "preact/hooks";
import type { CockpitModel } from "../../cockpit/model";
import type { CockpitStrings } from "../shared/control/messages";
import { Badge, Button, EmptyState, ListRow, PageChrome, QuickPicker, type QuickPickerItem } from "../shared/ui";
import type { FleetAction } from "./messages";

export type Strings = Pick<CockpitStrings,
  "fleetTitle" | "fleetHint" | "openMissionControl" | "noneListed" | "running" | "stopped" |
  "temporary" | "saved" | "stop" | "start" | "openTerminal" | "openActivity" | "openProbes" |
  "continueTask" | "editAgent" | "continueTaskPickTitle" | "continueTaskPickSubtitle" |
  "continueTaskPickPlaceholder" | "continueTaskPickEmpty" | "continueTaskDestStopped" |
  "continueTaskDestRunning" | "continueTaskDestDetail"
>;

export const defaultStrings: Strings = {
  fleetTitle: "Fleet", fleetHint: "Agents (runtime) — start, stop, terminal, activity. Work items are on the Board.",
  openMissionControl: "Open Board", noneListed: "Nothing listed yet.", running: "Running", stopped: "Stopped",
  temporary: "Temporary", saved: "Saved", stop: "Stop", start: "Start", openTerminal: "Open terminal",
  openActivity: "Activity", openProbes: "Probes", continueTask: "Continue task in…", editAgent: "Edit",
  continueTaskPickTitle: "Continue {0} task in…", continueTaskPickSubtitle: "Choose a stopped Saved Agent.",
  continueTaskPickPlaceholder: "Select an agent", continueTaskPickEmpty: "No eligible destination agents.",
  continueTaskDestStopped: "Stopped — available", continueTaskDestRunning: "Running — stop it first",
  continueTaskDestDetail: "Continue the unfinished task from {0}",
};

export function App({ model, strings: s, post }: { model?: CockpitModel; strings: Strings; post: (a: FleetAction) => void }) {
  // SDD 485 D7 — this is per-panel state. A module slot would let project B replace project A's picker.
  const [continuePick, setContinuePick] = useState<{ fromName: string; wsHash?: string } | null>(null);
  const rows = model?.fleet ?? [];
  return (
    <main class="ds-page">
      <PageChrome title={s.fleetTitle} hint={s.fleetHint} actions={<Button variant="primary" onClick={() => post({ type: "openBoard" })}>{s.openMissionControl}</Button>} />
      {rows.length === 0 ? <EmptyState kind="empty" message={s.noneListed} /> : (
        <div class="ck-card-list" data-testid="control-fleet">
          {rows.map((a) => (
            <ListRow key={`${a.wsHash ?? ""}:${a.name}`}
              title={<><span class="name">{a.name}</span><Badge tone={a.running ? "ok" : "default"}>{a.running ? s.running : s.stopped}</Badge>{a.lifetime === "temporary" ? <Badge tone="info">{s.temporary}</Badge> : <Badge>{s.saved}</Badge>}{a.kind ? <Badge>{a.kind}</Badge> : null}</>}
              meta={<>{a.folder ? <span>{a.folder}</span> : null}{a.wsHash ? <span class="ck-mono">{a.wsHash.slice(0, 8)}</span> : null}</>}
              actions={<>
                {a.running ? <Button variant="default" onClick={() => post({ type: "fleetStop", name: a.name, wsHash: a.wsHash })}>{s.stop}</Button> : <Button variant="default" onClick={() => post({ type: "fleetStart", name: a.name, wsHash: a.wsHash })}>{s.start}</Button>}
                <Button variant="default" onClick={() => post({ type: "fleetTerminal", name: a.name, wsHash: a.wsHash })}>{s.openTerminal}</Button>
                <Button variant="default" onClick={() => post({ type: "fleetActivity", name: a.name, wsHash: a.wsHash })}>{s.openActivity}</Button>
                <Button variant="default" onClick={() => post({ type: "fleetProbes", name: a.name, wsHash: a.wsHash })}>{s.openProbes}</Button>
                {a.lifetime !== "temporary" && a.kind !== "terminal" ? <Button variant="default" data-testid="fleet-continue-task" onClick={() => setContinuePick({ fromName: a.name, wsHash: a.wsHash })}>{s.continueTask}</Button> : null}
                {a.lifetime !== "temporary" ? <Button variant="default" onClick={() => post({ type: "fleetAgentStudio", name: a.name, wsHash: a.wsHash })}>{s.editAgent}</Button> : null}
              </>}
            />
          ))}
        </div>
      )}
      {continuePick ? <ContinuePicker model={model} pick={continuePick} s={s} close={() => setContinuePick(null)} post={post} /> : null}
    </main>
  );
}

function ContinuePicker({ model, pick, s, close, post }: { model?: CockpitModel; pick: { fromName: string; wsHash?: string }; s: Strings; close: () => void; post: (a: FleetAction) => void }) {
  const candidates = (model?.fleet ?? []).filter((row) => row.name !== pick.fromName)
    .filter((row) => !pick.wsHash || row.wsHash === pick.wsHash).filter((row) => row.kind !== "terminal")
    .filter((row) => row.lifetime !== "temporary").slice().sort((a, b) => Number(!!a.running) - Number(!!b.running));
  const items: QuickPickerItem[] = candidates.map((row) => ({
    id: `${row.wsHash ?? ""}:${row.name}`, label: row.name,
    description: row.running ? s.continueTaskDestRunning : s.continueTaskDestStopped,
    detail: row.running ? s.continueTaskDestRunning : s.continueTaskDestDetail.replace("{0}", pick.fromName),
    disabled: !!row.running, disabledReason: s.continueTaskDestRunning,
  }));
  return <QuickPicker open data-testid="fleet-continue-picker"
    title={s.continueTaskPickTitle.replace("{0}", pick.fromName)} subtitle={s.continueTaskPickSubtitle}
    placeholder={s.continueTaskPickPlaceholder} emptyText={s.continueTaskPickEmpty} items={items} onClose={close}
    onSelect={(item) => { close(); post({ type: "fleetContinueTask", name: pick.fromName, toName: item.label, wsHash: pick.wsHash }); }} />;
}
