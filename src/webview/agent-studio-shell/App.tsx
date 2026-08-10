import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { StudioTombstone } from "../shared/studio/StudioTombstone";
import { StudioLoadError } from "../shared/studio/StudioLoadError";
import { readTombstoneMessage, type StudioTombstoneInfo } from "../shared/studio/tombstone";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input, Select, Textarea } from "../shared/ui";
import { KitFilePicker } from "../shared/ui/kit";
import {
  AGENT_STUDIO_HOST_MESSAGE_NAMES,
  agentStudioTitleFor,
  blankAgentFields,
  canonicalAgentFields,
  nativeConfigChoice,
  nativeConfigSourceChoices,
  nativeConfigAuthorized,
  permissionAuthorizationChoices,
  permissionAuthorizationCopy,
  setNativeConfigAuthorized,
  computeAgentDirty,
  createAgentProfileLabels,
  newAgentRuntimeRefusal,
  serializeAgentPatch,
  setNativeConfigChoice,
  validateAgentStudioHostDomainMessage,
} from "./domain";
import {
  authorizePluginMessage,
  authorizeSkillMessage,
  refreshAuthorizableCapabilitiesMessage,
  browseMessage,
  cancelMessage,
  dirtyMessage,
  approveEvolutionCandidateMessage,
  loadEvolutionCandidateMessage,
  patchMessage,
  readyMessage,
  refreshEvolutionMessage,
  refreshAgentProfileMessage,
  setAgentProfileEnabledMessage,
  renameAgentProfileMessage,
  forgetAgentProfileMessage,
  planAgentProfileForgetMessage,
  setAgentProfileSubagentsMessage,
  setAgentProfileProposeGrantMessage,
  exportSavedAgentProfileBundleMessage,
  cloneSavedAgentProfileBundleMessage,
  importSavedAgentProfileBundleMessage,
  rejectEvolutionCandidateMessage,
  saveMessage,
} from "./messages";
import { RuntimeLogo } from "./runtimeLogos";
import { EvolutionSection } from "./EvolutionSection";
import { ForgetPlanView } from "./ForgetPlanView";
import type { AgentForgetPlanResultV1 } from "../../config/agentForgetPlan";
import type {
  AgentEvolutionCandidateDetailMessage,
  AgentEvolutionCandidateSummaryMessage,
  AgentEvolutionSummaryMessage,
  AgentStudioEntity,
  AgentStudioFields,
  AgentStudioHostMessage,
  AgentStudioPatch,
} from "./types";
import type { AgentOwnershipViewV1 } from "../../config/agentProfileStudio";
import type { AuthorizableCapabilities } from "../../config/agentCapabilityCandidates";
// Node-free by construction — same reason domain.ts may import it into this browser bundle.
import { ATTESTED_RUNTIMES } from "../../runtime/attestedRuntimes";
// Node-free for the same reason: these are the limits the host writer enforces at the door, shared
// so the form cannot accept text the transaction would refuse.
import { persistentInstructionsRefusal } from "../../config/agentInstructionsDocument";

/**
 * spec 350 Phase 3 T3 — the Agent-kind studio's webview surface: quick-add chips, name,
 * command + flag chips, instructions, autostart/restart/attention and the
 * worktree section, rendered inside StudioFrame's fields region (contiguous document flow under
 * Working directory — t-a1ba6c) instead of the old hand-rolled chrome. Faithful port of the fields
 * — same field names — just no kind tabs (this studio only ever creates/edits `kind: "agent"`).
 *
 * t-aa06a8 — the "Isolated harness" section is GONE, and with it `harnessRuntimeOfCmd`. It rendered
 * under `showHarness && !canonical`, and `canonical` is true for every agent this studio can load
 * (`AgentStudioAdapter.load` only reaches its `storage: "legacy"` arm for an agent-kind entry with
 * neither `profileLifecycle` nor `profilePointer`, and since t-ae221c no such entry exists). The
 * canonical profile schema has no `harness` key either, so the section had no destination even if
 * it had rendered. The harness MECHANISM is untouched — see src/harness/HarnessManager.ts.
 *
 * `firstToken` is deliberately reimplemented here (not imported from formLogic.ts) — formLogic.ts's
 * runtime exports transitively pull in `node:fs` (via config/loadConfig.ts), which this browser
 * bundle can't resolve (see agent-studio-shell/domain.ts's header for the empirical confirmation).
 *
 * t-610705 (Phase D, D1b) — Control-hosted now: props-driven, same split as every other migrated studio
 * (command-studio-shell/App.tsx's doc comment has the full rationale for routeKey/mountNonce/useStudioFreeze/
 * eager ref updates). The evolution message handling below is otherwise unchanged from the
 * standalone-panel version — those messages already carry their own `agent` field and are host-validated
 * against the CURRENT binding's entityId (agentStudioDomain.ts via StudioRegistryEntry.handleDomainMessage,
 * D1b — the retired Control host wired the same check in studioHost.ts), so no client-side identity
 * work was needed there beyond routing every evolution message through the same
 * identity-stamping `post` wrapper.
 */
export interface AgentStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
  /** t-bf3498 — the route's "← Parent" back-link, rendered under the studio title. */
  backLink?: ComponentChildren;
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function ProfileSourceCard({ title, access, scope, state }: { title: string; access: string; scope: string; state: string }) {
  return <article class="ash-profile-source">
    <div class="ash-profile-source-heading"><strong>{title}</strong><span class="ash-profile-access">{access}</span></div>
    <div class="ash-profile-source-meta"><span>{scope}</span><span>{state}</span></div>
  </article>;
}

const PROFILE_BUNDLE_MAX_BYTES = 256 * 1024;

function ProfileBundlePicker({ onCancel, onSelect }: { onCancel(): void; onSelect(contentBase64: string): void }) {
  const [error, setError] = useState<string | undefined>();
  return <KitFilePicker title="Import portable agent profile" description="Canonical Tachyon profile JSON, up to 256 KB."
    accept=".json,application/json" error={error} cancelLabel="Cancel import" onCancel={onCancel}
    onFile={async (file) => {
      if (!file || file.size < 1 || file.size > PROFILE_BUNDLE_MAX_BYTES) { setError("Choose a non-empty profile bundle up to 256 KB."); return; }
      try { onSelect(bytesToBase64(new Uint8Array(await file.arrayBuffer()))); }
      catch { setError("Tachyon could not read the selected bundle."); }
    }} />;
}

export function App({ dispatch, routeKey, mountNonce, incoming, backLink }: AgentStudioAppProps) {
  // t-5498a6 — candidate lists live outside `fields`: they are workspace state, not a profile edit,
  // and must never mark the form dirty. `undefined` means "not asked yet", which renders as Loading
  // rather than as an empty workspace — those are different facts.
  const [candidates, setCandidates] = useState<AuthorizableCapabilities | undefined>();
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<AgentStudioEntity | undefined>(undefined);
  const [fields, setFields] = useState<AgentStudioFields>(blankAgentFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  // t-b643ac — "the entity this document edits no longer exists" is a DOCUMENT STATE, held apart
  // from `hostError` because they are different facts: an error is something the form recovers
  // from, this is the form having no subject left. Conflating them is what kept a removed agent's
  // whole editor mounted under a red line, with Save one keystroke from clickable.
  const [tombstone, setTombstone] = useState<StudioTombstoneInfo | undefined>(undefined);
  const [evolutionSummary, setEvolutionSummary] = useState<AgentEvolutionSummaryMessage | undefined>(undefined);
  const [evolutionCandidates, setEvolutionCandidates] = useState<AgentEvolutionCandidateSummaryMessage[] | undefined>(undefined);
  const [evolutionDetail, setEvolutionDetail] = useState<AgentEvolutionCandidateDetailMessage | undefined>(undefined);
  const [evolutionBusy, setEvolutionBusy] = useState<string | undefined>(undefined);
  const [evolutionNotice, setEvolutionNotice] = useState<{ kind: "success" | "error"; text: string } | undefined>(undefined);
  const [profileBusy, setProfileBusy] = useState<string | undefined>(undefined);
  const [profileNotice, setProfileNotice] = useState<{ kind: "success" | "error"; text: string } | undefined>(undefined);
  const [profileConflict, setProfileConflict] = useState(false);
  const [renameConfirmOpen, setRenameConfirmOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [forgetConfirmOpen, setForgetConfirmOpen] = useState(false);
  const [forgetValue, setForgetValue] = useState("");
  // t-e722ce — the plan the human approves. `undefined` while the engine computes it; the typed
  // confirmation below stays hidden until it arrives, because confirming before reading the plan is
  // the order this change exists to invert.
  const [forgetPlan, setForgetPlan] = useState<AgentForgetPlanResultV1 | undefined>(undefined);
  const [profileRetired, setProfileRetired] = useState(false);
  const [ownership, setOwnership] = useState<AgentOwnershipViewV1 | undefined>(undefined);
  const [ownershipDraft, setOwnershipDraft] = useState<string[] | undefined>(undefined);
  const [bundleAction, setBundleAction] = useState<"clone" | "import" | undefined>();
  const [bundleDestination, setBundleDestination] = useState("");
  const [bundleImportBase64, setBundleImportBase64] = useState<string | undefined>();
  const bundleCancelButtonRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<AgentStudioEntity | undefined>(undefined);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);
  const renameCancelButtonRef = useRef<HTMLButtonElement>(null);
  const forgetCancelButtonRef = useRef<HTMLButtonElement>(null);

  const dirty = computeAgentDirty(entity, fields);
  dirtyRef.current = dirty;

  const post = (msg: object): void => dispatch.post({ ...msg, routeKey, mountNonce });

  const { frozen, saving: saveInFlight, frozenRef, freezeForSave } = useStudioFreeze({
    post: dispatch.post,
    getSnapshot: () => ({ dirty: dirtyRef.current, editRevision: editRevisionRef.current, patch: serializeAgentPatch(fieldsRef.current, dirtyRef.current) }),
  });

  // Re-handshake whenever the binding identity changes (fresh mount OR a same-route re-entry the
  // host rebound) — resets all local state so a stale entity/profile/
  // proposal never lingers across bindings, same reasoning as every other migrated studio.
  useEffect(() => {
    setMode("new");
    setEntityId(undefined);
    setEntity(undefined);
    entityRef.current = undefined;
    fieldsRef.current = blankAgentFields();
    dirtyRef.current = false;
    setFields(fieldsRef.current);
    setHostError(undefined);
    setLoadFailed(false);
    setEvolutionSummary(undefined);
    setEvolutionCandidates(undefined);
    setEvolutionDetail(undefined);
    setEvolutionBusy(undefined);
    setEvolutionNotice(undefined);
    setProfileBusy(undefined);
    setProfileNotice(undefined);
    setRenameConfirmOpen(false);
    setRenameValue("");
    setForgetConfirmOpen(false);
    setForgetValue("");
    setForgetPlan(undefined);
    setProfileRetired(false);
    setOwnership(undefined);
    setOwnershipDraft(undefined);
    setBundleAction(undefined); setBundleDestination(""); setBundleImportBase64(undefined);
    setTombstone(undefined);
    setReady(false);
    dispatch.post(readyMessage({ routeKey, mountNonce }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, mountNonce]);

  useEffect(() => {
    if (!incoming) return;
    const decoded = decodeStudioMessage<AgentStudioHostMessage>(incoming.message, AGENT_STUDIO_HOST_MESSAGE_NAMES);
    if (!decoded.ok || !decoded.message) {
      setHostError({
        code: "transport/protocol",
        message: `studio protocol: ${decoded.reason ?? "undecodable message"}`,
        source: "transport",
        blocking: true,
      });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
      return;
    }
    const d = decoded.message;
    if (AGENT_STUDIO_HOST_MESSAGE_NAMES.includes(d.type as never) && !validateAgentStudioHostDomainMessage(d)) {
      setHostError({ code: "transport/protocol", message: "studio protocol: malformed Agent Studio host response", source: "transport", blocking: true });
      setReady(true);
      return;
    }
    if (d.type === "load") {
      entityRef.current = d.entity;
      setEntity(d.entity);
      fieldsRef.current = d.entity.fields;
      dirtyRef.current = computeAgentDirty(d.entity, d.entity.fields);
      setFields(d.entity.fields);
      setMode(d.entity.name === undefined ? "new" : "edit");
      setEntityId(d.entity.name);
      setHostError(undefined);
      setLoadFailed(false);
      setEvolutionSummary(undefined);
      setEvolutionCandidates(undefined);
      setEvolutionDetail(undefined);
      setEvolutionBusy(d.entity.name ? "overview" : undefined);
      setEvolutionNotice(undefined);
      setProfileBusy(undefined);
      setProfileNotice(undefined);
      setProfileConflict(false);
      setRenameConfirmOpen(false);
      setRenameValue("");
      setForgetConfirmOpen(false);
      setForgetValue("");
      setForgetPlan(undefined);
      setProfileRetired(false);
      setOwnership(d.entity.ownership);
      setOwnershipDraft(d.entity.ownership ? [...d.entity.ownership.subagents] : undefined);
      setBundleAction(undefined); setBundleDestination(""); setBundleImportBase64(undefined);
      setReady(true);
      if (d.entity.name) {
        post(refreshEvolutionMessage(d.entity.name));
      }
    } else if (d.type === "tombstone") {
      setTombstone(readTombstoneMessage(d));
      setHostError(undefined);
      setLoadFailed(false);
      setReady(true);
    } else if (d.type === "error") {
      setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
    } else if (d.type === "restore") {
      if (d.snapshot?.patch) {
        const patch: AgentStudioPatch = d.snapshot.patch;
        const restored: AgentStudioFields = patch.kind === "agent-instance"
          ? {
              ...(entityRef.current?.fields ?? blankAgentFields()),
              name: patch.agentName,
              cmd: patch.editable.runtime.executable,
              canonical: {
                kind: "agent-instance",
                ...(patch.expectedRevision ? { expectedRevision: patch.expectedRevision } : {}),
                displayName: patch.editable.displayName,
                runtime: { ...patch.editable.runtime },
                nativeConfig: structuredClone(patch.editable.nativeConfig ?? {}),
                capabilities: structuredClone(patch.editable.capabilities ?? { skills: [], mcp: [], hooks: [] }),
              },
            }
          : patch;
        fieldsRef.current = restored;
        dirtyRef.current = computeAgentDirty(entityRef.current, restored);
        setFields(restored);
      }
    } else if (d.type === "cwd") {
      setHostError(undefined);
      setLoadFailed(false);
      const next = { ...fieldsRef.current, cwd: d.value };
      fieldsRef.current = next;
      dirtyRef.current = computeAgentDirty(entityRef.current, next);
      setFields(next);
    } else if (d.type === "evolutionSummary") {
      // A stale response for a previously viewed agent is discarded silently. All evolution
      // branches use the same binding check because only the matching-agent path clears
      // matching-agent path ever cleared `evolutionBusy`, so a stale response for a previously-viewed
      // agent left "Loading evolution state…" stuck forever).
      if (entityRef.current?.name !== d.summary.agent) return;
      setEvolutionSummary(d.summary);
    } else if (d.type === "evolutionCandidates") {
      if (entityRef.current?.name !== d.agent) return;
      setEvolutionCandidates(d.candidates);
      setEvolutionBusy(undefined);
    } else if (d.type === "evolutionCandidateDetail") {
      if (entityRef.current?.name !== d.agent) return;
      setEvolutionDetail(d.detail);
      setEvolutionBusy(undefined);
      setEvolutionNotice(undefined);
    } else if (d.type === "evolutionActionResult") {
      if (entityRef.current?.name !== d.agent) return;
      const labels = entityRef.current.evolutionLabels;
      setEvolutionDetail(undefined);
      setEvolutionBusy("overview");
      setEvolutionNotice({
        kind: "success",
        text: `${d.status === "approved" ? labels.approved : labels.rejected}. ${labels.nextSession}`,
      });
    } else if (d.type === "evolutionError") {
      if (entityRef.current?.name !== d.agent) return;
      setEvolutionBusy(undefined);
      if (d.conflict) setEvolutionDetail(undefined);
      setEvolutionNotice({ kind: "error", text: d.message });
    } else if (d.type === "agentProfileSnapshot") {
      const current = entityRef.current;
      if (!current || current.storage !== "canonical") return;
      const renamed = d.action === "rename" && current.name !== d.snapshot.agentName;
      const nextFields = canonicalAgentFields(d.snapshot);
      const updated = { ...current, profile: d.snapshot, fields: nextFields };
      entityRef.current = updated;
      fieldsRef.current = nextFields;
      dirtyRef.current = false;
      setEntity(updated);
      setFields(nextFields);
      setProfileBusy(undefined);
      setProfileConflict(false);
      setRenameConfirmOpen(false);
      setForgetConfirmOpen(false);
      setProfileRetired(renamed);
      setProfileNotice({
        kind: "success",
        text: renamed
          ? `Renamed to ${d.snapshot.agentName}. Reopen the agent from the sidebar to continue editing.`
          : d.action === "refresh" ? "Latest profile loaded."
            : d.action === "set-subagents" ? "Declared subagents saved."
            : d.action === "set-propose-saved-agent-grant"
              ? (d.snapshot.bindings.grants.proposeSavedAgent
                ? "Saved Agent proposals granted."
                : "Saved Agent proposals revoked.")
              : d.snapshot.enabled ? "Agent enabled." : "Agent disabled.",
      });
    } else if (d.type === "agentProfileOwnership") {
      if (entityRef.current?.name !== d.agent) return;
      setOwnership(d.ownership);
      setOwnershipDraft([...d.ownership.subagents]);
    } else if (d.type === "agentProfileForgetPlan") {
      if (entityRef.current?.name !== d.agent) return;
      // The panel state FOLLOWS the plan rather than racing it: a plan only ever arrives because
      // this panel asked for one, and a re-render that dropped the local flag would otherwise leave
      // the answer with nowhere to land. It also makes the surface addressable without a click,
      // which is how the preview harness can render it for review.
      setForgetConfirmOpen(true);
      setForgetPlan(d.result);
    } else if (d.type === "agentProfileForgotten") {
      if (entityRef.current?.name !== d.agent) return;
      setProfileBusy(undefined);
      setForgetConfirmOpen(false);
      setProfileRetired(true);
      setProfileNotice({ kind: "success", text: "Agent forgotten. Its recoverable retirement record was kept." });
    } else if (d.type === "authorizableCapabilities") {
      if (entityRef.current?.name !== d.agent) return;
      setCandidates(d.capabilities);
    } else if (d.type === "agentProfileError") {
      if (entityRef.current?.name !== d.agent) return;
      setProfileBusy(d.conflict ? "Refreshing profile" : undefined);
      setProfileConflict(d.conflict);
      setProfileNotice({ kind: "error", text: d.message });
    } else if (d.type === "agentProfileNotice") {
      // t-746f0f — the action worked; this says something about it the human cannot see on the
      // screen. It arrives AFTER the refreshes it belongs to, so it deliberately overwrites their
      // "Latest profile loaded." with the more specific sentence.
      if (entityRef.current?.name !== d.agent) return;
      setProfileBusy(undefined);
      setProfileNotice({ kind: "success", text: d.message });
    } else if (d.type === "agentProfileBundleExport") {
      if (entityRef.current?.name !== d.result.agentName) return;
      const bytes = Uint8Array.from(atob(d.result.contentBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = d.result.fileName; anchor.click(); URL.revokeObjectURL(url);
      setProfileBusy(undefined); setProfileNotice({ kind: "success", text: `Exported ${d.result.byteSize} bytes · SHA-256 ${d.result.sha256.slice(0, 12)}… · ${d.result.requiresReauthorization.length} reauthorization item(s).` });
    } else if (d.type === "agentProfileBundleCreated") {
      setProfileBusy(undefined); setBundleAction(undefined); setBundleDestination(""); setBundleImportBase64(undefined);
      setProfileNotice({ kind: "success", text: `${d.result.operation === "clone" ? "Cloned" : "Imported"} ${d.result.snapshot.agentName} disabled · SHA-256 ${d.result.bundleSha256.slice(0, 12)}… · ${d.result.requiresReauthorization.length} reauthorization item(s).` });
    } else if (d.type === "agentProfileBundleError") {
      if (entityRef.current?.name !== d.agent) return;
      setProfileBusy(d.conflict ? "Refreshing profile" : undefined); setProfileConflict(d.conflict); setProfileNotice({ kind: "error", text: d.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  useEffect(() => {
    if (!ready || frozen || tombstone) return;
    editRevisionRef.current += 1;
    post(dirtyMessage(dirty));
    post(patchMessage(serializeAgentPatch(fields, true)!, editRevisionRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields, frozen]);

  // t-5498a6 — ask for candidates once the canonical profile is bound. Not folded into the profile
  // snapshot: that snapshot is revisioned and the Studio uses the revision as a CAS token, while
  // installing a plugin changes no revision at all. Candidates are workspace state.
  useEffect(() => {
    const name = entityRef.current?.name;
    if (!name || !entityRef.current?.profile) return;
    post(refreshAuthorizableCapabilitiesMessage(name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityRef.current?.name, entityRef.current?.profile?.revision]);

  useEffect(() => {
    if (renameConfirmOpen) renameCancelButtonRef.current?.focus();
  }, [renameConfirmOpen]);

  useEffect(() => {
    // t-e722ce — `preventScroll`, because the panel now opens with a seven-step plan above these
    // buttons. Focusing Cancel used to scroll the plan off the top of the frame, landing the reader
    // on the two controls before the thing they are meant to read. Focus still goes to the safe
    // action (Escape-equivalent, unchanged); only the viewport stays where the human left it.
    if (forgetConfirmOpen) forgetCancelButtonRef.current?.focus({ preventScroll: true });
  }, [forgetConfirmOpen]);
  useEffect(() => { if (bundleAction) bundleCancelButtonRef.current?.focus(); }, [bundleAction]);

  // t-b643ac — decision 4, client half: the tombstone REPLACES the frame rather than banner-ing
  // above it, so Save/Cancel and every adapter action are ABSENT from the DOM instead of disabled
  // in it. Ahead of the loading check on purpose — a tab revived onto an entity that was removed
  // while the window was closed never receives an `entity`, and would otherwise load forever.
  if (tombstone) {
    return <StudioTombstone info={tombstone} backLink={backLink} onClose={() => post(cancelMessage())} />;
  }

  if (!ready) {
    return (
      <>
        {backLink ? <div class="ds-degrade-backlink">{backLink}</div> : null}
        <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Agent Studio...</div></div>
      </>
    );
  }

  // t-f4e186 — the host ANSWERED, and the answer carried no document. "Ready with no entity" and
  // "not ready yet" were the same branch above, which is why an `error` with no prior `load` left
  // this surface saying "Loading…" with no second answer coming. Split, they are what they are:
  // once the host has spoken, still-loading is not one of the things this screen may claim.
  if (!entity) {
    return (
      <StudioLoadError
        title={agentStudioTitleFor(mode, entityId, entity)}
        error={hostError}
        backLink={backLink}
        onClose={() => post(cancelMessage())}
      />
    );
  }

  // t-d68b8b — the only client-side blocking error this studio raises. It has to be here rather than
  // in `AgentStudioAdapter.validate()` (which stays NO_VALIDATION_ERRORS): the host validates on save,
  // and "you cannot create this" is the one answer the human needs BEFORE filling the rest of the form.
  const runtimeRefusal = newAgentRuntimeRefusal(fields);
  const runtimeRefusalError: StudioError | undefined = runtimeRefusal
    ? { code: "validation/agent-runtime-not-attested", message: runtimeRefusal, source: "validation", blocking: true }
    : undefined;
  const errors: StudioError[] = [...(hostError ? [hostError] : []), ...(runtimeRefusalError ? [runtimeRefusalError] : [])];
  const canSave = computeCanSave({
    dirty,
    blockingErrorCount: (hostError?.blocking ? 1 : 0) + (runtimeRefusalError ? 1 : 0),
    saveInFlight,
    concurrencyStale: false,
  });
  const updateFields = (updater: (fields: AgentStudioFields) => AgentStudioFields) => {
    if (frozenRef.current) return;
    setHostError(undefined);
    setLoadFailed(false);
    const next = updater(fieldsRef.current);
    fieldsRef.current = next;
    dirtyRef.current = computeAgentDirty(entityRef.current, next);
    setFields(next);
  };
  const set = <K extends keyof AgentStudioFields>(key: K, value: AgentStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const toggleFlag = (flag: string) => {
    const cmd = fields.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : (cmd.trim() + " " + flag).trim());
  };
  const pickChip = (bin: string) => {
    let name = fields.name;
    if (!fields.name || mode === "new") {
      let n = bin;
      let i = 2;
      // taken-name uniqueness is re-checked authoritatively at save time (studioSubmit) — this is only a
      // friendly default, so it doesn't need entity reference data beyond avoiding an obvious in-session clash.
      while (n === entityId) n = `${bin}-${i++}`;
      name = n;
    }
    updateFields((f) => ({ ...f, cmd: bin, name }));
  };

  const flags = entity.flagMap[firstToken(fields.cmd)] ?? [];
  const canonical = fields.canonical !== undefined;
  const canonicalRuntime = canonical
    ? (mode === "edit" ? fields.canonical!.runtime.adapter : firstToken(fields.cmd).split(/[\\/]/).pop())
    : undefined;
  const canonicalSnapshot = entity.profile;
  const profileLabels = entity.profileLabels ?? createAgentProfileLabels();
  const canonicalReadinessLimitationLabel = (limitation: NonNullable<typeof canonicalSnapshot>["readiness"]["limitations"][number]) => ({
    "runtime-baseline-unverified": profileLabels.runtimeLimitationBaselineUnverified,
    "fork-unavailable": profileLabels.runtimeLimitationForkUnavailable,
    "permission-policy-partial": profileLabels.runtimeLimitationPermissionPolicyPartial,
    "attention-composer-unverified": profileLabels.runtimeLimitationAttentionComposerUnverified,
    "stop-active-turn-unverified": profileLabels.runtimeLimitationStopActiveTurnUnverified,
    "oauth-concurrency-single-live": profileLabels.runtimeLimitationOauthConcurrencySingleLive,
  })[limitation];
  // t-afc86e — only true when the profile's setup reference belongs to someone other than
  // Agent Studio. A NEW agent has no profile and therefore no foreign reference, so the fields are
  // editable from the first keystroke.
  const foreignWorkspaceCommands = canonicalSnapshot?.bindings.foreignWorkspaceCommands === true;
  // t-d48775 — same rule for the instructions binding: only a profile whose `prompt.instructions`
  // names an id this Studio does not author is read-only here.
  const foreignPersistentInstructions = canonicalSnapshot?.bindings.foreignPersistentInstructions === true;
  // Answered while they are still typing, and with the same limits the host enforces at the door —
  // a form that accepts what the transaction refuses is a Save button that fails.
  const persistentInstructionsProblem = persistentInstructionsRefusal(fields.instructions);
  const savedAgent = entity.name;
  const mutationDisabled = !savedAgent || frozen;
  const refreshEvolution = () => {
    if (!savedAgent || frozenRef.current) return;
    setEvolutionBusy("overview");
    setEvolutionNotice(undefined);
    post(refreshEvolutionMessage(savedAgent));
  };
  const inspectEvolutionCandidate = (candidateId: string) => {
    if (!savedAgent || frozenRef.current) return;
    setEvolutionDetail(undefined);
    setEvolutionBusy(`candidate:${candidateId}`);
    setEvolutionNotice(undefined);
    post(loadEvolutionCandidateMessage(savedAgent, candidateId));
  };
  const resolveEvolutionCandidate = (detail: AgentEvolutionCandidateDetailMessage, action: "approve" | "reject") => {
    if (!savedAgent || frozenRef.current) return;
    setEvolutionBusy(action);
    setEvolutionNotice(undefined);
    post(action === "approve"
      ? approveEvolutionCandidateMessage(savedAgent, detail.id, detail.expectedActiveVersion, detail.expectedTargetDigest)
      : rejectEvolutionCandidateMessage(savedAgent, detail.id, detail.expectedActiveVersion, detail.expectedTargetDigest));
  };
  const canonicalLifecycleDisabled = !canonicalSnapshot || !!profileBusy || dirty || frozen || profileRetired;
  // Declared + still-declarable, so a checked row can always be UNCHECKED even after the target
  // stopped qualifying as a candidate (it stops qualifying precisely BECAUSE this agent owns it).
  const ownershipRows = [...new Set([...(ownership?.subagents ?? []), ...(ownership?.candidates ?? [])])].sort();
  const ownershipDirty = ownership !== undefined && ownershipDraft !== undefined
    && (ownershipDraft.length !== ownership.subagents.length
      || [...ownershipDraft].sort().join("\0") !== [...ownership.subagents].sort().join("\0"));
  const runCanonicalLifecycle = (label: string, message: object) => {
    if (canonicalLifecycleDisabled) return;
    setHostError(undefined);
    setProfileNotice(undefined);
    setProfileBusy(label);
    post(message);
  };

  const onSave = () => {
    if (frozenRef.current) return;
    freezeForSave();
    post(saveMessage());
  };

  return (
    <StudioFrame
      title={agentStudioTitleFor(mode, entityId, entity)}
      backLink={backLink}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      canSave={canSave}
      frozen={frozen}
      onSave={onSave}
      onCancel={() => post(cancelMessage())}
      regions={{
        fields: (
          <div class="ash-fields">
            {canonical && mode === "edit" && (
              <section class="ash-identity" aria-labelledby="ash-lifecycle-title">
                <div class="ash-identity-heading">
                  <div>
                    <div class="ash-label" id="ash-lifecycle-title">{profileLabels.lifecycleTitle}</div>
                    <div class="hint">{profileLabels.lifecycleHelp}</div>
                  </div>
                  <span class={`ash-profile-state ${canonicalSnapshot?.enabled ? "ash-profile-state-active" : ""}`}>
                    {profileRetired ? profileLabels.closed : profileConflict ? profileLabels.conflict : profileNotice?.kind === "error" ? profileLabels.degraded : canonicalSnapshot?.enabled ? profileLabels.enabled : profileLabels.disabled}
                  </span>
                </div>
                <div class="ash-identity-actions" role="group" aria-label="Agent lifecycle actions">
                  <Button
                    variant={canonicalSnapshot?.enabled ? "default" : "primary"}
                    disabled={canonicalLifecycleDisabled}
                    onClick={() => canonicalSnapshot && runCanonicalLifecycle(
                      canonicalSnapshot.enabled ? "Disabling agent" : "Enabling agent",
                      setAgentProfileEnabledMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, !canonicalSnapshot.enabled),
                    )}
                  >{canonicalSnapshot?.enabled ? profileLabels.disableAgent : profileLabels.enableAgent}</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => canonicalSnapshot && runCanonicalLifecycle(
                    "Refreshing profile",
                    refreshAgentProfileMessage(canonicalSnapshot.agentName),
                  )}>{profileLabels.refresh}</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => {
                    setRenameValue(canonicalSnapshot?.agentName ?? "");
                    setRenameConfirmOpen(true);
                    setForgetConfirmOpen(false);
                  }}>{profileLabels.rename}</Button>
                  <Button variant="danger" disabled={canonicalLifecycleDisabled} onClick={() => {
                    // ONE click computes the plan. Nothing destructive is armed by this button any
                    // more — it opens a panel that is empty until the engine answers what it would do.
                    setForgetValue("");
                    setForgetPlan(undefined);
                    setForgetConfirmOpen(true);
                    setRenameConfirmOpen(false);
                    if (canonicalSnapshot) post(planAgentProfileForgetMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision));
                  }}>{profileLabels.forget}</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => canonicalSnapshot && runCanonicalLifecycle("Exporting profile", exportSavedAgentProfileBundleMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision))}>{profileLabels.export}</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => { setBundleAction("clone"); setBundleDestination(""); setBundleImportBase64(undefined); }}>{profileLabels.clone}</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => { setBundleAction("import"); setBundleDestination(""); setBundleImportBase64(undefined); }}>{profileLabels.import}</Button>
                </div>
                {canonicalSnapshot && (
                  <div class="ash-runtime-readiness" aria-labelledby="ash-runtime-readiness-title">
                    <div class="ash-runtime-readiness-heading">
                      <div>
                        <div class="ash-label" id="ash-runtime-readiness-title">{profileLabels.runtimeReadinessTitle}</div>
                        <div class="hint">{profileLabels.runtimeReadinessHelp}</div>
                      </div>
                      <span class={`ash-profile-state ${canonicalSnapshot.readiness.state === "ready" ? "ash-profile-state-active" : "ash-runtime-readiness-limited"}`}>
                        {canonicalSnapshot.readiness.state === "ready" ? profileLabels.runtimeReady : profileLabels.runtimeLimited}
                      </span>
                    </div>
                    {canonicalSnapshot.readiness.limitations.length > 0 && (
                      <ul>{canonicalSnapshot.readiness.limitations.map((limitation) => <li key={limitation}>{canonicalReadinessLimitationLabel(limitation)}</li>)}</ul>
                    )}
                  </div>
                )}
                {canonicalSnapshot && ownership && (
                  <div class="ash-ownership" aria-labelledby="ash-ownership-title">
                    <div class="ash-label" id="ash-ownership-title">{profileLabels.ownershipTitle}</div>
                    <div class="hint">{profileLabels.ownershipHelp}</div>
                    {ownership.ownedBy !== undefined
                      ? <div class="ash-profile-status">{profileLabels.ownershipOwnedBy.replace("{0}", ownership.ownedBy)}</div>
                      : ownershipRows.length === 0
                        ? <div class="ash-profile-status">{profileLabels.ownershipNoCandidates}</div>
                        : (
                          <>
                            <ul class="ash-ownership-list">
                              {ownershipRows.map((child) => {
                                const checked = (ownershipDraft ?? []).includes(child);
                                return (
                                  <li key={child}>
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={canonicalLifecycleDisabled}
                                        onChange={() => setOwnershipDraft((draft) => {
                                          const next = new Set(draft ?? []);
                                          if (next.has(child)) next.delete(child);
                                          else next.add(child);
                                          return [...next].sort();
                                        })}
                                      />
                                      <span>{child}</span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                            {ownership.subagents.length === 0 && <div class="hint">{profileLabels.ownershipNone}</div>}
                            <div class="ash-profile-replace-confirm-actions">
                              <Button
                                variant="primary"
                                disabled={canonicalLifecycleDisabled || !ownershipDirty}
                                onClick={() => runCanonicalLifecycle(
                                  "Saving declared subagents",
                                  setAgentProfileSubagentsMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, [...(ownershipDraft ?? [])]),
                                )}
                              >{profileLabels.ownershipApply}</Button>
                            </div>
                          </>
                        )}
                  </div>
                )}
                {canonicalSnapshot && (
                  <div class="ash-ownership" aria-labelledby="ash-propose-grant-title">
                    <div class="ash-label" id="ash-propose-grant-title">{profileLabels.proposeGrantTitle}</div>
                    <div class="hint">{profileLabels.proposeGrantHelp}</div>
                    <label class="check">
                      <input
                        type="checkbox"
                        id="ash-propose-grant"
                        checked={canonicalSnapshot.bindings.grants.proposeSavedAgent}
                        disabled={canonicalLifecycleDisabled}
                        onChange={(event) => runCanonicalLifecycle(
                          (event.currentTarget as HTMLInputElement).checked
                            ? "Granting Saved Agent proposals"
                            : "Revoking Saved Agent proposals",
                          setAgentProfileProposeGrantMessage(
                            canonicalSnapshot.agentName,
                            canonicalSnapshot.revision,
                            (event.currentTarget as HTMLInputElement).checked,
                          ),
                        )}
                      />
                      {" "}{profileLabels.proposeGrantLabel}
                    </label>
                    <div class="hint ash-native-config-risk">{profileLabels.proposeGrantRisk}</div>
                    <div class="ash-profile-status">
                      {canonicalSnapshot.bindings.grants.proposeSavedAgent
                        ? profileLabels.proposeGrantOn
                        : profileLabels.proposeGrantOff}
                    </div>
                  </div>
                )}
                {dirty && <div class="ash-profile-status">{profileLabels.saveFirst}</div>}
                {renameConfirmOpen && canonicalSnapshot && (
                  <div class="ash-profile-replace-confirm" aria-labelledby="ash-rename-confirm-title">
                    <div class="ash-profile-replace-confirm-title" id="ash-rename-confirm-title">Rename this agent?</div>
                    <label class="ash-label" for="ash-rename-value">New name</label>
                    <Input id="ash-rename-value" value={renameValue} onInput={(event) => setRenameValue((event.currentTarget as HTMLInputElement).value)} />
                    <div class="ash-profile-replace-confirm-actions">
                      <Button ref={renameCancelButtonRef} onClick={() => setRenameConfirmOpen(false)}>Cancel</Button>
                      <Button variant="primary" disabled={renameValue === canonicalSnapshot.agentName || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(renameValue)} onClick={() => runCanonicalLifecycle(
                        "Renaming agent",
                        renameAgentProfileMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, renameValue),
                      )}>Rename agent</Button>
                    </div>
                  </div>
                )}
                {forgetConfirmOpen && canonicalSnapshot && (
                  <div class="ash-profile-delete-confirm" aria-labelledby="ash-forget-confirm-title">
                    <div class="ash-profile-delete-confirm-title" id="ash-forget-confirm-title">Forget {canonicalSnapshot.agentName}</div>
                    <ForgetPlanView result={forgetPlan} />
                    {forgetPlan?.kind === "plan" && forgetPlan.plan.executable && (
                      <>
                        <div>Type <strong>{canonicalSnapshot.agentName}</strong> to approve the plan above.</div>
                        <Input aria-label="Agent name confirmation" value={forgetValue} onInput={(event) => setForgetValue((event.currentTarget as HTMLInputElement).value)} />
                      </>
                    )}
                    <div class="ash-profile-delete-confirm-actions">
                      <Button ref={forgetCancelButtonRef} onClick={() => { setForgetConfirmOpen(false); setForgetPlan(undefined); }}>Cancel</Button>
                      <Button
                        variant="danger"
                        disabled={forgetPlan?.kind !== "plan" || !forgetPlan.plan.executable || forgetValue !== canonicalSnapshot.agentName}
                        onClick={() => forgetPlan?.kind === "plan" && runCanonicalLifecycle(
                          "Forgetting agent",
                          // The plan's revision, not the snapshot's: the human approved THAT reading of
                          // the workspace, and if the profile moved since, the engine must refuse rather
                          // than execute a plan nobody was shown.
                          forgetAgentProfileMessage(canonicalSnapshot.agentName, forgetPlan.plan.revision, forgetValue),
                        )}
                      >Approve and execute</Button>
                    </div>
                  </div>
                )}
                {bundleAction === "import" && !bundleImportBase64 && (
                  <ProfileBundlePicker onCancel={() => setBundleAction(undefined)} onSelect={setBundleImportBase64} />
                )}
                {bundleAction && (bundleAction === "clone" || bundleImportBase64) && canonicalSnapshot && (
                  <div class="ash-profile-replace-confirm" aria-labelledby="ash-bundle-action-title">
                    <div class="ash-profile-replace-confirm-title" id="ash-bundle-action-title">{bundleAction === "clone" ? "Clone portable profile" : "Import portable profile"}</div>
                    <div>Creates a new disabled agent. Secrets, grants and workspace bindings must be authorized again.</div>
                    <label class="ash-label" for="ash-bundle-destination">New agent name</label>
                    <Input id="ash-bundle-destination" value={bundleDestination} onInput={(event) => setBundleDestination((event.currentTarget as HTMLInputElement).value)} />
                    <div class="ash-profile-replace-confirm-actions">
                      <Button ref={bundleCancelButtonRef} onClick={() => { setBundleAction(undefined); setBundleImportBase64(undefined); }}>Cancel</Button>
                      <Button variant="primary" disabled={!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(bundleDestination)} onClick={() => runCanonicalLifecycle(
                        bundleAction === "clone" ? "Cloning profile" : "Importing profile",
                        bundleAction === "clone"
                          ? cloneSavedAgentProfileBundleMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, bundleDestination)
                          : importSavedAgentProfileBundleMessage(canonicalSnapshot.agentName, bundleDestination, bundleImportBase64!),
                      )}>{bundleAction === "clone" ? "Clone agent" : "Import agent"}</Button>
                    </div>
                  </div>
                )}
                {(profileBusy || profileNotice) && (
                  <div class={`ash-evolution-notice ${profileNotice?.kind === "error" ? "ash-evolution-notice-error" : ""}`} role="status" aria-live="polite">
                    {profileBusy ? `${profileBusy}…` : profileNotice?.text}
                    {profileNotice?.kind === "error" && canonicalSnapshot && !profileBusy && <Button onClick={() => runCanonicalLifecycle(
                      "Refreshing profile",
                      refreshAgentProfileMessage(canonicalSnapshot.agentName),
                    )}>{profileLabels.retryRefresh}</Button>}
                  </div>
                )}
              </section>
            )}
            {canonicalSnapshot && mode === "edit" && (
              <section class="ash-profile-sources" aria-labelledby="ash-profile-sources-title">
                <div>
                  <div class="ash-label" id="ash-profile-sources-title">{profileLabels.provenanceTitle}</div>
                  <div class="hint">{profileLabels.provenanceHelp}</div>
                </div>
                <div class="ash-profile-source-grid">
                  <ProfileSourceCard title={profileLabels.authoredProfile} access={profileLabels.writable} scope={profileLabels.profileScope} state={canonicalSnapshot.provenance.canonical.sha256.slice(0, 12) + "…"} />
                  <ProfileSourceCard title={profileLabels.hostAuthority} access={profileLabels.readOnly} scope={profileLabels.hostScope} state={`${profileLabels.grants}: ${canonicalSnapshot.provenance.authority.grants}`} />
                  <ProfileSourceCard title={profileLabels.learnedState} access={profileLabels.readOnly} scope={profileLabels.profileScope} state={canonicalSnapshot.provenance.learned.present ? profileLabels.present : profileLabels.absent} />
                  <ProfileSourceCard title={profileLabels.runtimeProjection} access={profileLabels.readOnly} scope={profileLabels.runtimeScope} state={canonicalSnapshot.provenance.projection.active ? profileLabels.active : profileLabels.inactive} />
                </div>
                <div class="ash-profile-bindings">
                  <div class="ash-label">{profileLabels.bindingsTitle}</div>
                  <span>{profileLabels.environmentValues}: {canonicalSnapshot.bindings.environmentValueNames.length}</span>
                  <span>{profileLabels.secrets}: {canonicalSnapshot.bindings.secretNames.length}</span>
                  <span>{profileLabels.externalReferences}: {canonicalSnapshot.bindings.externalReferences}</span>
                  <span>{profileLabels.capabilities}: {Object.values(canonicalSnapshot.bindings.capabilities).reduce((sum, count) => sum + count, 0)}</span>
                  <span>{profileLabels.promptInputs}: {Object.entries(canonicalSnapshot.bindings.prompt).filter(([key, value]) => key !== "memoryPolicy" && value === true).length}</span>
                  <span>{profileLabels.profileIdentity}: <code>{canonicalSnapshot.agentId.slice(0, 8)}…</code></span>
                </div>
                <div class="ash-native-config">
                  <div class="ash-label">{profileLabels.nativeConfigTitle}</div>
                  <div class="hint">{profileLabels.nativeConfigHelp}</div>
                  {(canonicalSnapshot.provenance.nativeConfig ?? []).length === 0
                    ? <div class="ash-native-config-empty">{profileLabels.nativeConfigEmpty}</div>
                    : canonicalSnapshot.provenance.nativeConfig!.map((entry) => (
                      <div class="ash-native-config-row" key={entry.family}>
                        <code>{entry.family}</code>
                        <span>{entry.source} · {entry.treatment} · {entry.refresh}</span>
                        <span>{entry.lifecycle.join(", ")}</span>
                        <span class={`ash-native-config-${entry.support}`} title={entry.reason}>
                          {entry.support === "supported" ? profileLabels.supported : profileLabels.unsupported}
                        </span>
                      </div>
                    ))}
                </div>
                <div class="ash-native-config">
                  <div class="ash-label">Runtime tooling</div>
                  <div class="hint">Only pre-authorized profile references can be enabled here. Commands, source files, credentials and runtime trust state are never shown.</div>
                  {(["skills", "mcp", "hooks"] as const).map((family) => canonicalSnapshot.bindings.tooling[family].map((item) => {
                    const enabled = fields.canonical?.capabilities[family].includes(item.id) ?? false;
                    return <label class="check" key={`${family}:${item.id}`}>
                      <input type="checkbox" checked={enabled} disabled={mutationDisabled} onChange={(event) => updateFields((current) => {
                        if (!current.canonical) return current;
                        const selected = new Set(current.canonical.capabilities[family]);
                        if ((event.currentTarget as HTMLInputElement).checked) selected.add(item.id);
                        else selected.delete(item.id);
                        return { ...current, canonical: {
                          ...current.canonical,
                          capabilities: { ...current.canonical.capabilities, [family]: [...selected].sort() },
                        } };
                      })} />
                      <code>{item.id}</code> <span class="hint">{family} · {item.scope}</span>
                    </label>;
                  }))}
                  {Object.values(canonicalSnapshot.bindings.tooling).every((items) => items.length === 0) && <div class="ash-native-config-empty">No pre-authorized tooling references are available for this profile.</div>}
                  {/* t-5498a6 — the two selectors. Kept separate because a skill installed by a
                    * Tachyon plugin and one written by hand here are different things: the plugin is
                    * versioned and pinned at its own tree, the hand-written one has only its content.
                    * The discriminator is the plugin LOCKFILE, never a content comparison — a plugin
                    * skill edited by hand diverges and is still the plugin's. */}
                  <div class="ash-label" style="margin-top:12px">Workspace skills (not from a plugin)</div>
                  <div class="hint">Authorize gives this agent the skill and enables it. Untick it above to turn it off without withdrawing the authorization — the pinned digest survives, so turning it back on needs no fresh approval.</div>
                  {candidates === undefined
                    ? <div class="ash-native-config-empty">Loading…</div>
                    : candidates.workspaceSkills.length === 0
                      ? <div class="ash-native-config-empty">No hand-written skills in this workspace for this runtime.</div>
                      : candidates.workspaceSkills.map((skill) => (
                        <div class="ash-native-config-row" key={`ws:${skill.name}`}>
                          <code>{skill.name}</code>
                          <span class="hint">{skill.path}{skill.authorized?.stale ? " · content changed since you authorized it" : ""}</span>
                          {/* t-4a2a6f — three states, three renders. An already-authorized skill used
                            * to render exactly like a new one, so the only control offered was the one
                            * the core correctly refuses to honour silently. */}
                          {skill.authorized === undefined
                            ? <Button disabled={mutationDisabled} onClick={() => entity.name && post(authorizeSkillMessage(entity.name, skill.name, false))}>Authorize</Button>
                            : skill.authorized.stale
                              ? <Button disabled={mutationDisabled} onClick={() => entity.name && post(authorizeSkillMessage(entity.name, skill.name, true))}>Reauthorize</Button>
                              : <span class="hint">Authorized</span>}
                        </div>
                      ))}

                  <div class="ash-label" style="margin-top:12px">Tachyon plugins</div>
                  <div class="hint">Authorize gives this agent everything the plugin exposes for this runtime, enabled. A plugin that also installs something no capability grant can carry is refused whole — half a plugin reported as success would be worse than a refusal.</div>
                  {candidates === undefined
                    ? <div class="ash-native-config-empty">Loading…</div>
                    : candidates.plugins.length === 0
                      ? <div class="ash-native-config-empty">No Tachyon plugins are installed in this workspace.</div>
                      : candidates.plugins.map((plugin) => (
                        <div class="ash-native-config-row" key={`plugin:${plugin.name}`}>
                          <code>{plugin.name}@{plugin.version}</code>
                          {/* t-4a2a6f — the version delta, not two digests. "authorized at 2.1.2, now
                            * 3.0.0" is the sentence that connects the refusal to the plugin update
                            * that caused it; `expected e468…, consumed 6f27…` never did. */}
                          <span class="hint">
                            {plugin.skills.length > 0 ? plugin.skills.join(", ") : "—"}
                            {plugin.authorized?.stale
                              ? plugin.authorized.version && plugin.authorized.version !== plugin.version
                                ? ` · authorized at ${plugin.authorized.version}, now ${plugin.version}`
                                : " · content changed since you authorized it"
                              : ""}
                          </span>
                          {/* An unauthorizable plugin is SHOWN with its reason rather than hidden: a
                            * hidden option is indistinguishable from one that is not installed. */}
                          {!plugin.authorizable
                            ? <span class="hint" title={plugin.reason}>{plugin.reason}</span>
                            : plugin.authorized === undefined
                              ? <Button disabled={mutationDisabled} onClick={() => entity.name && post(authorizePluginMessage(entity.name, plugin.name, false))}>Authorize</Button>
                              : plugin.authorized.stale
                                ? <Button disabled={mutationDisabled} onClick={() => entity.name && post(authorizePluginMessage(entity.name, plugin.name, true))}>Reauthorize</Button>
                                : <span class="hint">Authorized</span>}
                        </div>
                      ))}
                  {/* t-c01f91 — git-hook plugins act on the CHECKOUT, not on an agent: `core.hooksPath`
                    * is repository-level and shared by every worktree, so they already apply and
                    * there is nothing to authorize. Named rather than dropped silently — listing one
                    * as "installs nothing" would read as absence while the gate is working. */}
                  {candidates && candidates.checkoutOnlyPlugins.length > 0 && (
                    <div class="hint">Already active on this checkout via git hooks, not agent capabilities: {candidates.checkoutOnlyPlugins.join(", ")}.</div>
                  )}
                </div>
              </section>
            )}
            <div class="ash-group">
              <div class="ash-label">Quick add (detected on this machine)</div>
              <div class="ash-chips" role="group" aria-label="Quick add">
                {entity.chips.map((c) => (
                  <Chip key={c.bin} class={c.detected ? "ash-runtime-chip ash-runtime-chip-detected" : "ash-runtime-chip"} active={fields.cmd === c.bin} disabled={!c.detected} onClick={() => c.detected && pickChip(c.bin)} title={c.installHint}>
                    <RuntimeLogo id={c.bin} />
                    {c.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div class="ash-grid ash-grid-compact">
              <div class="ash-field">
                <label class="ash-label" for="ash-name">Name</label>
                <Input id="ash-name" value={fields.name} disabled={canonical && mode === "edit"} placeholder="frontend, revisor, dev..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
              </div>

            </div>

            <div class="ash-group">
              <label class="ash-label" for="ash-cmd">Command</label>
              {/* t-d68b8b — a canonical agent's placeholder is the attested list itself. It used to
                * read "claude · codex · agy · npm run dev", offering by example the two things this
                * door cannot create: an unattested runtime and a generic process. A legacy entry keeps
                * the old text — that form still edits whatever is already written in `agents:`. */}
              <Input id="ash-cmd" value={fields.cmd} placeholder={canonical ? ATTESTED_RUNTIMES.join(" · ") : "claude · codex · agy · npm run dev"} onInput={(e) => set("cmd", (e.currentTarget as HTMLInputElement).value)} />
              {!canonical && <div class="ash-chips">
                {flags.map((flag) => (
                  <Chip key={flag} active={fields.cmd.includes(flag)} onClick={() => toggleFlag(flag)}>{flag}</Chip>
                ))}
              </div>}
            </div>

            {canonical && (canonicalRuntime === "codex" || canonicalRuntime === "claude" || canonicalRuntime === "grok") && (
              <section class="ash-native-config-editor" aria-labelledby="ash-runtime-selectors-title">
                <div>
                  <div class="ash-label" id="ash-runtime-selectors-title">{profileLabels.runtimeSelectorsTitle}</div>
                  <div class="hint">{profileLabels.runtimeSelectorsHelp}</div>
                </div>
                <div class="ash-grid ash-grid-compact">
                  <div class="ash-field">
                    <label class="ash-label" for="ash-runtime-model">{profileLabels.runtimeModel}</label>
                    <Input
                      id="ash-runtime-model"
                      value={fields.canonical!.runtime.model ?? ""}
                      placeholder={profileLabels.runtimeDefault}
                      onInput={(event) => updateFields((current) => current.canonical ? ({
                        ...current,
                        canonical: {
                          ...current.canonical,
                          runtime: {
                            ...current.canonical.runtime,
                            model: (event.currentTarget as HTMLInputElement).value || undefined,
                          },
                        },
                      }) : current)}
                    />
                  </div>
                  <div class="ash-field">
                    <label class="ash-label" for="ash-runtime-effort">{profileLabels.runtimeReasoningEffort}</label>
                    {canonicalRuntime === "claude" || canonicalRuntime === "grok" ? (
                      <Select
                        id="ash-runtime-effort"
                        value={fields.canonical!.runtime.reasoningEffort ?? ""}
                        onChange={(event) => updateFields((current) => current.canonical ? ({
                          ...current,
                          canonical: {
                            ...current.canonical,
                            runtime: {
                              ...current.canonical.runtime,
                              reasoningEffort: (event.currentTarget as HTMLSelectElement).value || undefined,
                            },
                          },
                        }) : current)}
                      >
                        <option value="">{profileLabels.runtimeDefault}</option>
                        {/* t-26f508 — Grok's canonical levels add `none`/`minimal`; per-model menu ids
                            are deliberately absent because they only resolve against one model. */}
                        {(canonicalRuntime === "grok"
                          ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
                          : ["low", "medium", "high", "xhigh", "max"]
                        ).map((effort) => <option value={effort}>{effort}</option>)}
                      </Select>
                    ) : (
                      <Input
                        id="ash-runtime-effort"
                        value={fields.canonical!.runtime.reasoningEffort ?? ""}
                        placeholder={profileLabels.runtimeDefault}
                        onInput={(event) => updateFields((current) => current.canonical ? ({
                          ...current,
                          canonical: {
                            ...current.canonical,
                            runtime: {
                              ...current.canonical.runtime,
                              reasoningEffort: (event.currentTarget as HTMLInputElement).value || undefined,
                            },
                          },
                        }) : current)}
                      />
                    )}
                  </div>
                  {canonicalRuntime === "codex" && (
                    <>
                      <div class="ash-field">
                        <label class="ash-label" for="ash-runtime-provider">{profileLabels.runtimeProvider}</label>
                        <Input
                          id="ash-runtime-provider"
                          value={fields.canonical!.runtime.provider ?? ""}
                          placeholder={profileLabels.runtimeDefault}
                          onInput={(event) => updateFields((current) => current.canonical ? ({
                            ...current,
                            canonical: {
                              ...current.canonical,
                              runtime: {
                                ...current.canonical.runtime,
                                provider: (event.currentTarget as HTMLInputElement).value || undefined,
                              },
                            },
                          }) : current)}
                        />
                      </div>
                      <div class="ash-field">
                        <label class="ash-label" for="ash-runtime-service-tier">{profileLabels.runtimeServiceTier}</label>
                        <Input
                          id="ash-runtime-service-tier"
                          value={fields.canonical!.runtime.serviceTier ?? ""}
                          placeholder={profileLabels.runtimeDefault}
                          onInput={(event) => updateFields((current) => current.canonical ? ({
                            ...current,
                            canonical: {
                              ...current.canonical,
                              runtime: {
                                ...current.canonical.runtime,
                                serviceTier: (event.currentTarget as HTMLInputElement).value || undefined,
                              },
                            },
                          }) : current)}
                        />
                      </div>
                    </>
                  )}
                </div>
              </section>
            )}

            {canonical && (canonicalRuntime === "codex" || canonicalRuntime === "claude" || canonicalRuntime === "grok") && (
              <section class="ash-native-config-editor" aria-labelledby="ash-native-config-editor-title">
                <div>
                  <div class="ash-label" id="ash-native-config-editor-title">{profileLabels.nativeConfigTitle}</div>
                  <div class="hint">{profileLabels.nativeConfigHelp}</div>
                </div>
                {([
                  ["permissions", profileLabels.nativeConfigPermissions],
                  ["interface", profileLabels.nativeConfigInterface],
                  ["featureFlags", profileLabels.nativeConfigFeatureFlags],
                ] as const).map(([family, label]) => (
                  <div class="ash-native-config-editor-row" key={family}>
                    <label for={`ash-native-config-${family}`}>{label}</label>
                    <Select
                      id={`ash-native-config-${family}`}
                      value={nativeConfigChoice(fields, family)}
                      onChange={(event) => updateFields((current) => setNativeConfigChoice(
                        current,
                        family,
                        (event.currentTarget as HTMLSelectElement).value as "exclude" | "global" | "workspace",
                      ))}
                    >
                      <option value="exclude">{profileLabels.nativeConfigExclude}</option>
                      {/* Only the sources this runtime actually honors are offered (t-26f508). */}
                      {nativeConfigSourceChoices(fields).map((source) => (
                        <option value={source} key={source}>
                          {source === "global" ? profileLabels.nativeConfigGlobal : profileLabels.nativeConfigWorkspace}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
                {permissionAuthorizationChoices(fields).map((member) => {
                  const copy = permissionAuthorizationCopy(profileLabels, member);
                  return (
                    <div class="ash-native-config-authorization" key={member}>
                      <label class="check">
                        <input
                          type="checkbox"
                          id={`ash-native-config-authorize-${member}`}
                          checked={nativeConfigAuthorized(fields, member)}
                          onChange={(event) => updateFields((current) => setNativeConfigAuthorized(
                            current,
                            member,
                            (event.currentTarget as HTMLInputElement).checked,
                          ))}
                        />
                        {" "}{copy.label}
                      </label>
                      <div class="hint ash-native-config-risk">{copy.risk}</div>
                    </div>
                  );
                })}
              </section>
            )}

            {/*
              * t-d48775 — this field was `disabled={canonical}` with an inviting placeholder and a hint
              * reading "not editable in this form yet". `canonical` is true for every agent this studio
              * can load (see the header), so it was disabled for everyone, and the binding the hint
              * pointed at had no writer anywhere in the product. Both halves are gone: the text is
              * authored here and published as a pinned document in the same transaction as the rest of
              * the form, and the hint now says where it goes.
              */}
            <section class="ash-static-section" aria-labelledby="ash-persistent-instructions-title">
              <div class="ash-label" id="ash-persistent-instructions-title">Persistent instructions</div>
              {/*
                * The placeholder is dropped on the read-only branch, and that is the SECOND half of
                * this defect rather than a detail. A placeholder is an invitation to type; measured
                * on the Visual QA capture, a disabled box carrying one is indistinguishable at a
                * glance from the editable field below it, and the sentence that disqualifies it sits
                * one line lower — where the eye only goes after trying. Empty is honest: nothing
                * invites, and the hint carries the whole message.
                */}
              <Textarea disabled={foreignPersistentInstructions} rows={4} value={fields.instructions} placeholder={foreignPersistentInstructions ? "" : "you are a code reviewer; read the diff and flag correctness issues…"} onInput={(e) => set("instructions", (e.currentTarget as HTMLTextAreaElement).value)} />
              <div class="hint">{foreignPersistentInstructions
                ? "This agent's instructions are published by another owner, not by this profile — they are shown read-only so a save cannot overwrite them."
                : canonical
                  ? "Delivered at the start of every session for this agent. Saved in the profile as instructions.md and re-read on restart; clear the box to remove them."
                  : entity.persistentInstructionsHelp}</div>
              {persistentInstructionsProblem && <div class="hint ash-native-config-risk">{persistentInstructionsProblem}</div>}
            </section>

            <EvolutionSection
              labels={entity.evolutionLabels}
              savedAgent={savedAgent}
              enabled={fields.selfEvolution}
              // t-f96b2f — this was `toggleDisabled={canonical}`, and `canonical` is always true, so
              // the control could never be used: `Workspace.enableAgentSelfEvolution` had been
              // complete since t-d185e1 with zero callers. It is wired now, and stays read-only for
              // exactly one case — an agent that does not exist yet. Evolution pins a selector naming
              // a profile id the Evolution store mints, so it needs the profile the save is about to
              // create; the section already says "Save agent first" for everything else it offers.
              toggleDisabled={canonical && !canonicalSnapshot}
              summary={evolutionSummary}
              candidates={evolutionCandidates}
              detail={evolutionDetail}
              busy={evolutionBusy}
              notice={evolutionNotice}
              onToggle={(enabled) => set("selfEvolution", enabled)}
              onRefresh={refreshEvolution}
              onInspect={inspectEvolutionCandidate}
              onApprove={(detail) => resolveEvolutionCandidate(detail, "approve")}
              onReject={(detail) => resolveEvolutionCandidate(detail, "reject")}
            />

            <><div class="checks ash-check-grid">
              <label><input type="checkbox" checked={fields.autostart} onChange={(e) => set("autostart", (e.currentTarget as HTMLInputElement).checked)} /> Auto-start</label>
              <label><input type="checkbox" checked={fields.restartOnCrash} onChange={(e) => set("restartOnCrash", (e.currentTarget as HTMLInputElement).checked)} /> Restart on crash</label>
              <label><input type="checkbox" checked={fields.attention} onChange={(e) => set("attention", (e.currentTarget as HTMLInputElement).checked)} /> Attention detection</label>
            </div>

            {/* t-bd14d8 — there is deliberately NO "Watch patterns" field here, and re-adding one is a
              * regression rather than a feature. A watch restarts the PROCESS when files change, and
              * `Workspace.rebuildWatches` runs that restart as `{ stop: "force", session: "new" }` —
              * "not resume", in the comment's own words. For `bun run dev` that is the feature; for an
              * LLM agent it force-kills the session and opens a fresh one because somebody saved a file,
              * discarding transcript and work in progress with no human gesture. Terminal Studio keeps
              * its `Watch files` field, and that is where the capability lives. */}

            {/* t-da80ed — an isolated agent's working directory IS its worktree, and the runtime
             * already overwrites this field's value with the worktree path. Leaving it editable let a
             * human type a path, save without error, and get nothing. Disabled, and the placeholder
             * states the directory that will actually be used instead of the workspace root. */}
            <div class="ash-group">
              <label class="ash-label" for="ash-cwd">Working directory</label>
              <div class="ash-row">
                <Input
                  id="ash-cwd"
                  disabled={fields.worktree}
                  value={fields.worktree ? "" : fields.cwd}
                  placeholder={fields.worktree ? "(its own git worktree — see below)" : `(workspace root: ${entity.defaultCwd})`}
                  onInput={(e) => set("cwd", (e.currentTarget as HTMLInputElement).value)}
                />
                <Button disabled={fields.worktree} onClick={() => post(browseMessage())}>Browse</Button>
              </div>
              {fields.worktree && <div class="hint">This agent runs in its own git worktree, which is its working directory. Turn the isolation off below to choose a directory.</div>}
              {canonical && <div class="hint">{profileLabels.canonicalTrustHelp}</div>}
            </div>

            {/* t-a1ba6c — advanced sections live in the main fields column (natural document flow
             * under Working directory). StudioFrame's sideActions slot sits AFTER flex:1 main and
             * was pinning these as a lonely bottom footer with a huge empty void on short forms. */}
            <section class="ash-static-section" aria-labelledby="ash-worktree-title">
              <div class="ash-label" id="ash-worktree-title">Git worktree isolation</div>
              <div class="hint">Run this agent in a dedicated branch and worktree, with optional setup commands.</div>
              {/* t-da80ed — turning isolation ON clears the working directory in the same gesture.
                * Without this, a profile that already carried a cwd would disable the field while
                * keeping its value, and the save would then refuse over something the human can
                * neither see nor edit. */}
              <label class="check"><input type="checkbox" checked={fields.worktree} onChange={(e) => {
                const enabled = (e.currentTarget as HTMLInputElement).checked;
                updateFields((current) => ({ ...current, worktree: enabled, ...(enabled ? { cwd: "" } : {}) }));
              }} /> Run in its own git worktree + branch</label>
              <label class="ash-label" for="ash-branch">Branch (blank = tachyon/&lt;name&gt;)</label>
              <Input id="ash-branch" value={fields.branch} placeholder="feature/auth-redesign" onInput={(e) => set("branch", (e.currentTarget as HTMLInputElement).value)} />
              {/* t-afc86e — setup is published as a pinned profile-local document in the same
                * transaction as the save. It stays read-only when another owner published it. */}
              <label class="ash-label" for="ash-setup">Setup commands (run once on create)</label>
              <Textarea id="ash-setup" disabled={foreignWorkspaceCommands} rows={3} value={fields.worktreeSetup} placeholder="python -m venv .venv&#10;pip install -e . (one per line)" onInput={(e) => set("worktreeSetup", (e.currentTarget as HTMLTextAreaElement).value)} />
              {foreignWorkspaceCommands && <div class="hint">This agent's setup is published by the workspace, not by this profile — it is shown read-only so a save cannot overwrite it.</div>}
            </section>

            </>
          </div>
        ),
      }}
    />
  );
}
