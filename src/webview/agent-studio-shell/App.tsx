import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input, Select, Textarea } from "../shared/ui";
import { KitDropdown, KitDropdownContent, KitDropdownItem, KitDropdownSeparator, KitDropdownTrigger, KitFilePicker } from "../shared/ui/kit";
import {
  AGENT_STUDIO_HOST_MESSAGE_NAMES,
  SOUL_IMPORT_MAX_BYTES,
  agentStudioTitleFor,
  blankAgentFields,
  canonicalAgentFields,
  computeAgentDirty,
  serializeAgentPatch,
  isAllowedSoulImportFileName,
  validateAgentStudioHostDomainMessage,
} from "./domain";
import {
  adoptSoulProfileMessage,
  browseMessage,
  cancelMessage,
  createSoulMessage,
  deleteSoulProfileMessage,
  dirtyMessage,
  disableSoulMessage,
  enableSoulMessage,
  importSoulMessage,
  approveEvolutionCandidateMessage,
  loadEvolutionCandidateMessage,
  openSoulMessage,
  patchMessage,
  readyMessage,
  replaceSoulMessage,
  refreshSoulMessage,
  refreshEvolutionMessage,
  refreshCanonicalProfileMessage,
  setCanonicalProfileEnabledMessage,
  renameCanonicalProfileMessage,
  forgetCanonicalProfileMessage,
  rejectEvolutionCandidateMessage,
  saveMessage,
} from "./messages";
import { RuntimeLogo } from "./runtimeLogos";
import { EvolutionSection } from "./EvolutionSection";
import type {
  AgentEvolutionCandidateDetailMessage,
  AgentEvolutionCandidateSummaryMessage,
  AgentEvolutionSummaryMessage,
  AgentStudioEntity,
  AgentStudioFields,
  AgentStudioHostMessage,
  AgentStudioPatch,
  SoulProfileStatusMessage,
} from "./types";

/**
 * spec 350 Phase 3 T3 — the Agent-kind studio's webview surface: quick-add chips, name,
 * command + flag chips, role template, instructions, autostart/restart/attention,
 * worktree section, isolated-harness section) rendered inside StudioFrame's fields region (contiguous
 * document flow under Working directory — t-a1ba6c) instead of the old hand-rolled chrome. Faithful port
 * of the fields — same field names, same show/hide rules (harness for claude/codex/opencode/grok/hermes) —
 * just no kind tabs (this studio only ever creates/edits `kind: "agent"`).
 *
 * `firstToken`/`harnessRuntimeOfCmd` are deliberately reimplemented here (not imported from formLogic.ts) —
 * formLogic.ts's runtime exports transitively pull in `node:fs` (via config/loadConfig.ts), which this
 * browser bundle can't resolve (see agent-studio-shell/domain.ts's header for the empirical confirmation).
 *
 * t-610705 (Phase D, D1b) — Control-hosted now: props-driven, same split as every other migrated studio
 * (command-studio-shell/App.tsx's doc comment has the full rationale for routeKey/mountNonce/useStudioFreeze/
 * eager ref updates). The soul-profile/evolution message handling below is otherwise UNCHANGED from the
 * standalone-panel version — those messages already carry their own `agent` field and are host-validated
 * against the CURRENT binding's entityId (studioHost.ts's `StudioMessageHooks.handleDomainMessage`, D1b
 * addition — see agentStudioDomain.ts), so no client-side identity work was needed there beyond routing
 * every message (including soul/evolution ones) through the same identity-stamping `post` wrapper.
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
/** Keep in sync with formLogic.harnessRuntimeOf / loadConfig HARNESS_BINS. */
const HARNESS_STUDIO_BINS = new Set(["claude", "codex", "opencode", "grok", "hermes"]);
const harnessRuntimeOfCmd = (cmd: string): string | undefined => {
  const bin = firstToken(cmd);
  return HARNESS_STUDIO_BINS.has(bin) ? bin : undefined;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // t-610705 (Phase D, D1b) — this file is now transitively typechecked (cockpit/App.tsx's dynamic
  // import pulls it into tsconfig.webview.json's graph for the first time; it was esbuild-only
  // before, which doesn't type-check). `Uint8Array`'s `buffer` widened to include SharedArrayBuffer
  // in this TS lib version, which `crypto.subtle.digest`'s BufferSource param rejects — always a
  // real ArrayBuffer here (constructed locally from a File's arrayBuffer()), never shared.
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

interface SoulImportSelection {
  contentBase64: string;
  fileName: string;
  bytes: number;
  sha256: string;
}

function SoulImportPicker({ onCancel, onSelect }: {
  onCancel(): void;
  onSelect(selection: SoulImportSelection): void;
}) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    if (!isAllowedSoulImportFileName(file.name)) {
      setError("Choose a .md, .markdown, or .txt file.");
      return;
    }
    if (file.size === 0) {
      setError("The selected file is empty.");
      return;
    }
    if (file.size > SOUL_IMPORT_MAX_BYTES) {
      setError("The selected file is larger than 64 KB.");
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0 || bytes.length > SOUL_IMPORT_MAX_BYTES) {
        setError(bytes.length === 0 ? "The selected file is empty." : "The selected file is larger than 64 KB.");
        return;
      }
      onSelect({
        contentBase64: bytesToBase64(bytes),
        fileName: file.name,
        bytes: bytes.length,
        sha256: await sha256Hex(bytes),
      });
    } catch {
      setError("Tachyon could not read the selected file.");
    } finally {
      setReading(false);
    }
  };

  return (
    <KitFilePicker
      title="Import identity file"
      description={<>Markdown or text, up to 64 KB. Tachyon copies the contents into this agent&apos;s managed SOUL.md.</>}
      accept=".md,.markdown,.txt,text/markdown,text/plain"
      disabled={reading}
      error={error}
      draggingLabel="Drop to import"
      cancelLabel="Cancel import"
      onFile={selectFile}
      onCancel={onCancel}
    />
  );
}

export function App({ dispatch, routeKey, mountNonce, incoming, backLink }: AgentStudioAppProps) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<AgentStudioEntity | undefined>(undefined);
  const [fields, setFields] = useState<AgentStudioFields>(blankAgentFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [soulStatus, setSoulStatus] = useState<SoulProfileStatusMessage | undefined>(undefined);
  const [soulBusy, setSoulBusy] = useState<string | undefined>(undefined);
  const [soulImportOpen, setSoulImportOpen] = useState(false);
  const [soulReplacePending, setSoulReplacePending] = useState<SoulImportSelection | undefined>(undefined);
  const [soulDeleteConfirmOpen, setSoulDeleteConfirmOpen] = useState(false);
  const [evolutionSummary, setEvolutionSummary] = useState<AgentEvolutionSummaryMessage | undefined>(undefined);
  const [evolutionCandidates, setEvolutionCandidates] = useState<AgentEvolutionCandidateSummaryMessage[] | undefined>(undefined);
  const [evolutionDetail, setEvolutionDetail] = useState<AgentEvolutionCandidateDetailMessage | undefined>(undefined);
  const [evolutionBusy, setEvolutionBusy] = useState<string | undefined>(undefined);
  const [evolutionNotice, setEvolutionNotice] = useState<{ kind: "success" | "error"; text: string } | undefined>(undefined);
  const [profileBusy, setProfileBusy] = useState<string | undefined>(undefined);
  const [profileNotice, setProfileNotice] = useState<{ kind: "success" | "error"; text: string } | undefined>(undefined);
  const [renameConfirmOpen, setRenameConfirmOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [forgetConfirmOpen, setForgetConfirmOpen] = useState(false);
  const [forgetValue, setForgetValue] = useState("");
  const [profileRetired, setProfileRetired] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<AgentStudioEntity | undefined>(undefined);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const replaceCancelButtonRef = useRef<HTMLButtonElement>(null);
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
  // host rebound) — resets ALL local state (soul/evolution included) so a stale entity/profile/
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
    setSoulStatus(undefined);
    setSoulBusy(undefined);
    setSoulImportOpen(false);
    setSoulReplacePending(undefined);
    setSoulDeleteConfirmOpen(false);
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
    setProfileRetired(false);
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
      setSoulStatus(undefined);
      setSoulBusy(d.entity.name ? "Refreshing profile" : undefined);
      setSoulImportOpen(false);
      setSoulReplacePending(undefined);
      setSoulDeleteConfirmOpen(false);
      setEvolutionSummary(undefined);
      setEvolutionCandidates(undefined);
      setEvolutionDetail(undefined);
      setEvolutionBusy(d.entity.name ? "overview" : undefined);
      setEvolutionNotice(undefined);
      setProfileBusy(undefined);
      setProfileNotice(undefined);
      setRenameConfirmOpen(false);
      setRenameValue("");
      setForgetConfirmOpen(false);
      setForgetValue("");
      setProfileRetired(false);
      setReady(true);
      if (d.entity.name) {
        post(refreshSoulMessage(d.entity.name));
        post(refreshEvolutionMessage(d.entity.name));
      }
    } else if (d.type === "error") {
      setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
      if (!entityRef.current) setLoadFailed(true);
      setSoulBusy(undefined);
      setReady(true);
    } else if (d.type === "restore") {
      if (d.snapshot?.patch) {
        const patch: AgentStudioPatch = d.snapshot.patch;
        const restored: AgentStudioFields = patch.kind === "canonical"
          ? {
              ...(entityRef.current?.fields ?? blankAgentFields()),
              name: patch.agentName,
              cmd: patch.editable.runtime.executable,
              role: patch.editable.role,
              canonical: {
                kind: "canonical",
                ...(patch.expectedRevision ? { expectedRevision: patch.expectedRevision } : {}),
                displayName: patch.editable.displayName,
                runtime: { ...patch.editable.runtime },
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
    } else if (d.type === "soulProfileStatus") {
      // t-0e8a9a — a stale response for a PREVIOUSLY-viewed agent (still in flight when the user
      // switched to this one) is discarded silently, not surfaced as a blocking protocol error: the
      // old "set hostError + return" here left `soulBusy`/`evolutionBusy` stuck forever (every sibling
      // branch below had the identical bug) since only the matching-agent path ever cleared it —
      // matches this codebase's established discipline elsewhere for a stale cross-binding message
      // (discard, don't error).
      if (entityRef.current?.name !== d.status.agent) return;
      setHostError(undefined);
      setSoulStatus(d.status);
      setSoulBusy(undefined);
      setSoulReplacePending(undefined);
      if (d.status.lifecycle !== "missing") setSoulImportOpen(false);
      if (d.status.lifecycle === "missing") setSoulDeleteConfirmOpen(false);
      const current = entityRef.current;
      if (current && current.fields.soul !== d.status.soulEnabled) {
        const updated = { ...current, fields: { ...current.fields, soul: d.status.soulEnabled } };
        entityRef.current = updated;
        setEntity(updated);
      }
      if (fieldsRef.current.soul !== d.status.soulEnabled) {
        const next = { ...fieldsRef.current, soul: d.status.soulEnabled };
        fieldsRef.current = next;
        dirtyRef.current = computeAgentDirty(entityRef.current, next);
        setFields(next);
      }
    } else if (d.type === "soulProfileError") {
      // t-0e8a9a — see soulProfileStatus's comment above; same discard-stale-cross-agent-message fix.
      if (entityRef.current?.name !== d.agent) return;
      setSoulBusy(undefined);
      setHostError({ code: d.code, message: d.message, source: "persistence", blocking: false });
    } else if (d.type === "evolutionSummary") {
      // t-0e8a9a — see soulProfileStatus's comment above; same discard-stale-cross-agent-message fix
      // (all 5 evolution message branches below share the identical pre-existing bug: only the
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
    } else if (d.type === "canonicalProfileSnapshot") {
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
      setRenameConfirmOpen(false);
      setForgetConfirmOpen(false);
      setProfileRetired(renamed);
      setProfileNotice({
        kind: "success",
        text: renamed
          ? `Renamed to ${d.snapshot.agentName}. Reopen the agent from the sidebar to continue editing.`
          : d.action === "refresh" ? "Latest profile loaded." : d.snapshot.enabled ? "Agent enabled." : "Agent disabled.",
      });
    } else if (d.type === "canonicalProfileForgotten") {
      if (entityRef.current?.name !== d.agent) return;
      setProfileBusy(undefined);
      setForgetConfirmOpen(false);
      setProfileRetired(true);
      setProfileNotice({ kind: "success", text: "Agent forgotten. Its recoverable retirement record was kept." });
    } else if (d.type === "canonicalProfileError") {
      if (entityRef.current?.name !== d.agent) return;
      setProfileBusy(d.conflict ? "Refreshing profile" : undefined);
      setProfileNotice({ kind: "error", text: d.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  useEffect(() => {
    if (!ready || frozen) return;
    editRevisionRef.current += 1;
    post(dirtyMessage(dirty));
    post(patchMessage(serializeAgentPatch(fields, true)!, editRevisionRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields, frozen]);

  useEffect(() => {
    if (soulDeleteConfirmOpen) deleteCancelButtonRef.current?.focus();
  }, [soulDeleteConfirmOpen]);

  useEffect(() => {
    if (soulReplacePending) replaceCancelButtonRef.current?.focus();
  }, [soulReplacePending]);

  useEffect(() => {
    if (renameConfirmOpen) renameCancelButtonRef.current?.focus();
  }, [renameConfirmOpen]);

  useEffect(() => {
    if (forgetConfirmOpen) forgetCancelButtonRef.current?.focus();
  }, [forgetConfirmOpen]);

  if (!ready || !entity) {
    return (
      <>
        {backLink ? <div class="ds-degrade-backlink">{backLink}</div> : null}
        <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Agent Studio...</div></div>
      </>
    );
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
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
  const canonicalSnapshot = entity.profile;
  const harnessRuntime = harnessRuntimeOfCmd(fields.cmd);
  const showHarness = !!harnessRuntime;
  const showHarnessRules = harnessRuntime === "claude";
  const showHarnessInstructions = harnessRuntime === "codex";
  const harnessCheckboxLabel =
    harnessRuntime === "codex"
      ? "Give this Codex agent its own config, skills, hooks, and MCP"
      : harnessRuntime === "grok"
        ? "Give this Grok agent its own GROK_HOME (config, skills, hooks, MCP)"
        : harnessRuntime === "hermes"
          ? "Give this Hermes agent its own HERMES_HOME (config, skills, hooks, MCP)"
          : harnessRuntime === "opencode"
            ? "Give this OpenCode agent its own XDG home (config, skills, hooks, MCP)"
            : "Give this agent its own MCP / skills / rules / hooks";

  const savedAgent = entity.name;
  const profilePresent = !!soulStatus && soulStatus.lifecycle !== "missing";
  const readActionDisabled = !savedAgent || !!soulBusy;
  const mutationDisabled = readActionDisabled || !soulStatus || soulStatus.transactionDegraded;
  const showCreateOrImport = soulStatus?.lifecycle === "missing";
  const enableRequiresOwnershipClaim = !!soulStatus?.sha256
    && (soulStatus.lifecycle === "retained" || soulStatus.lifecycle === "unowned");
  const showEnable = enableRequiresOwnershipClaim || (soulStatus?.lifecycle === "active"
    && soulStatus.resolvable
    && !soulStatus.soulEnabled);
  const showDisable = !!soulStatus?.soulEnabled;
  const showDelete = profilePresent && !soulStatus?.soulEnabled;
  const canCreate = showCreateOrImport && !mutationDisabled && !soulImportOpen;
  const canImport = !mutationDisabled && !soulImportOpen && !soulReplacePending
    && (!profilePresent || !!soulStatus?.sha256);
  const canEnable = showEnable && !mutationDisabled;
  const canDisable = showDisable && !mutationDisabled;
  const canDelete = showDelete && !mutationDisabled;
  const lifecycleLabel: Record<SoulProfileStatusMessage["lifecycle"], string> = {
    missing: "Missing",
    active: "Active",
    retained: "Disabled",
    unowned: "Ready to enable",
    invalid: "Invalid",
  };
  const runSoulAction = (label: string, message: unknown) => {
    if (frozenRef.current) return;
    setHostError(undefined);
    setSoulImportOpen(false);
    setSoulReplacePending(undefined);
    setSoulDeleteConfirmOpen(false);
    setSoulBusy(label);
    post(message as object);
  };
  const runEnableSoul = () => {
    // t-610705 (Phase D, D1b) — same newly-typechecked-file note as sha256Hex above: `runEnableSoul`
    // is only ever wired to a button inside the `savedAgent ? (...) : (...)` JSX branch below, so
    // this was never reachable with `savedAgent` undefined — this guard just makes that explicit for
    // the type-checker, matching refreshEvolution/inspectEvolutionCandidate's own `if (!savedAgent)` convention.
    if (!savedAgent) return;
    runSoulAction(
      "Enabling Soul",
      enableRequiresOwnershipClaim && soulStatus?.sha256
        ? adoptSoulProfileMessage(savedAgent, soulStatus.sha256)
        : enableSoulMessage(savedAgent),
    );
  };
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
                    <div class="ash-label" id="ash-lifecycle-title">Agent lifecycle</div>
                    <div class="hint">Operational actions use the loaded profile revision and stay separate from form save.</div>
                  </div>
                  <span class={`ash-soul-state ${canonicalSnapshot?.enabled ? "ash-soul-state-active" : ""}`}>
                    {profileRetired ? "Closed" : canonicalSnapshot?.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div class="ash-identity-actions" role="group" aria-label="Agent lifecycle actions">
                  <Button
                    variant={canonicalSnapshot?.enabled ? "default" : "primary"}
                    disabled={canonicalLifecycleDisabled}
                    onClick={() => canonicalSnapshot && runCanonicalLifecycle(
                      canonicalSnapshot.enabled ? "Disabling agent" : "Enabling agent",
                      setCanonicalProfileEnabledMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, !canonicalSnapshot.enabled),
                    )}
                  >{canonicalSnapshot?.enabled ? "Disable agent" : "Enable agent"}</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => canonicalSnapshot && runCanonicalLifecycle(
                    "Refreshing profile",
                    refreshCanonicalProfileMessage(canonicalSnapshot.agentName),
                  )}>Refresh</Button>
                  <Button disabled={canonicalLifecycleDisabled} onClick={() => {
                    setRenameValue(canonicalSnapshot?.agentName ?? "");
                    setRenameConfirmOpen(true);
                    setForgetConfirmOpen(false);
                  }}>Rename…</Button>
                  <Button variant="danger" disabled={canonicalLifecycleDisabled} onClick={() => {
                    setForgetValue("");
                    setForgetConfirmOpen(true);
                    setRenameConfirmOpen(false);
                  }}>Forget…</Button>
                </div>
                {dirty && <div class="ash-soul-status">Save or discard form changes before a lifecycle action.</div>}
                {renameConfirmOpen && canonicalSnapshot && (
                  <div class="ash-soul-replace-confirm" aria-labelledby="ash-rename-confirm-title">
                    <div class="ash-soul-replace-confirm-title" id="ash-rename-confirm-title">Rename this agent?</div>
                    <label class="ash-label" for="ash-rename-value">New name</label>
                    <Input id="ash-rename-value" value={renameValue} onInput={(event) => setRenameValue((event.currentTarget as HTMLInputElement).value)} />
                    <div class="ash-soul-replace-confirm-actions">
                      <Button ref={renameCancelButtonRef} onClick={() => setRenameConfirmOpen(false)}>Cancel</Button>
                      <Button variant="primary" disabled={renameValue === canonicalSnapshot.agentName || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(renameValue)} onClick={() => runCanonicalLifecycle(
                        "Renaming agent",
                        renameCanonicalProfileMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, renameValue),
                      )}>Rename agent</Button>
                    </div>
                  </div>
                )}
                {forgetConfirmOpen && canonicalSnapshot && (
                  <div class="ash-soul-delete-confirm" aria-labelledby="ash-forget-confirm-title">
                    <div class="ash-soul-delete-confirm-title" id="ash-forget-confirm-title">Forget this agent?</div>
                    <div>This retires the canonical profile and removes the declared agent. Type <strong>{canonicalSnapshot.agentName}</strong> to confirm.</div>
                    <Input aria-label="Agent name confirmation" value={forgetValue} onInput={(event) => setForgetValue((event.currentTarget as HTMLInputElement).value)} />
                    <div class="ash-soul-delete-confirm-actions">
                      <Button ref={forgetCancelButtonRef} onClick={() => setForgetConfirmOpen(false)}>Cancel</Button>
                      <Button variant="danger" disabled={forgetValue !== canonicalSnapshot.agentName} onClick={() => runCanonicalLifecycle(
                        "Forgetting agent",
                        forgetCanonicalProfileMessage(canonicalSnapshot.agentName, canonicalSnapshot.revision, forgetValue),
                      )}>Forget agent</Button>
                    </div>
                  </div>
                )}
                {(profileBusy || profileNotice) && (
                  <div class={`ash-evolution-notice ${profileNotice?.kind === "error" ? "ash-evolution-notice-error" : ""}`} role="status" aria-live="polite">
                    {profileBusy ? `${profileBusy}…` : profileNotice?.text}
                  </div>
                )}
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

            <section class="ash-identity" aria-labelledby="ash-identity-title">
              <div class="ash-identity-heading">
                <div>
                  <div class="ash-label" id="ash-identity-title">Identity (SOUL.md)</div>
                  <div class="hint">Stable identity for this agent. Keep operational instructions in the separate field below.</div>
                </div>
                <span class={`ash-soul-state ash-soul-state-${soulStatus?.lifecycle ?? "loading"}`}>
                  {savedAgent
                    ? soulStatus ? lifecycleLabel[soulStatus.lifecycle] : "Loading status"
                    : "Save agent first"}
                </span>
              </div>

              {savedAgent ? (
                <>
                  <div class="ash-identity-actions" role="group" aria-label="SOUL.md actions">
                    {showCreateOrImport && (
                      <Button variant="primary" icon="new-file" disabled={!canCreate} onClick={() => runSoulAction("Creating profile", createSoulMessage(savedAgent))}>Create</Button>
                    )}
                    {profilePresent && (
                      <Button icon="go-to-file" disabled={readActionDisabled} onClick={() => runSoulAction("Opening profile", openSoulMessage(savedAgent))}>Edit file</Button>
                    )}
                    {soulStatus && (
                      <Button
                        icon="folder-opened"
                        disabled={!canImport}
                        onClick={() => {
                          setHostError(undefined);
                          setSoulDeleteConfirmOpen(false);
                          setSoulReplacePending(undefined);
                          setSoulImportOpen(true);
                        }}
                      >Import</Button>
                    )}
                    {showEnable && (
                      <Button
                        variant="primary"
                        icon="check"
                        disabled={!canEnable}
                        onClick={runEnableSoul}
                      >Enable Soul</Button>
                    )}
                    {showDisable && (
                      <Button disabled={!canDisable} onClick={() => runSoulAction("Disabling Soul", disableSoulMessage(savedAgent))}>Disable Soul</Button>
                    )}
                    {soulStatus && (
                      <KitDropdown>
                        <KitDropdownTrigger asChild>
                          <Button icon="ellipsis" aria-label="More SOUL.md actions">More</Button>
                        </KitDropdownTrigger>
                        <KitDropdownContent align="start">
                          <KitDropdownItem disabled={readActionDisabled} onSelect={() => runSoulAction("Refreshing profile", refreshSoulMessage(savedAgent))}>Refresh</KitDropdownItem>
                          {showDelete && (
                            <>
                              <KitDropdownSeparator />
                              <KitDropdownItem
                                variant="destructive"
                                disabled={!canDelete}
                                onSelect={() => {
                                  setHostError(undefined);
                                  setSoulImportOpen(false);
                                  setSoulReplacePending(undefined);
                                  setSoulDeleteConfirmOpen(true);
                                }}
                              >Delete identity permanently…</KitDropdownItem>
                            </>
                          )}
                        </KitDropdownContent>
                      </KitDropdown>
                    )}
                  </div>

                  {soulImportOpen && (
                    <SoulImportPicker
                      onCancel={() => setSoulImportOpen(false)}
                      onSelect={(selection) => {
                        setSoulImportOpen(false);
                        if (profilePresent && soulStatus?.sha256) {
                          setSoulReplacePending(selection);
                        } else {
                          runSoulAction("Importing profile", importSoulMessage(savedAgent, selection.contentBase64));
                        }
                      }}
                    />
                  )}

                  {soulReplacePending && soulStatus?.sha256 && (
                    <div class="ash-soul-replace-confirm" aria-labelledby="ash-soul-replace-confirm-title">
                      <div class="ash-soul-replace-confirm-title" id="ash-soul-replace-confirm-title">Replace existing identity?</div>
                      <div><strong>{soulReplacePending.fileName}</strong> ({soulReplacePending.bytes} bytes) will replace <code>{soulStatus.relativePath}</code>.</div>
                      <div>The selected source file will not be modified. Soul will remain {soulStatus.soulEnabled ? "enabled" : "disabled"}.</div>
                      <dl class="ash-soul-replace-digests">
                        <div><dt>Current SHA-256</dt><dd><code>{soulStatus.sha256}</code></dd></div>
                        <div><dt>New SHA-256</dt><dd><code>{soulReplacePending.sha256}</code></dd></div>
                      </dl>
                      <div class="ash-soul-replace-confirm-actions">
                        <Button ref={replaceCancelButtonRef} onClick={() => setSoulReplacePending(undefined)}>Cancel</Button>
                        <Button
                          variant="danger"
                          disabled={mutationDisabled}
                          onClick={() => runSoulAction(
                            "Replacing identity",
                            replaceSoulMessage(savedAgent, soulReplacePending.contentBase64, soulStatus.sha256!),
                          )}
                        >Replace identity</Button>
                      </div>
                    </div>
                  )}

                  {soulDeleteConfirmOpen && soulStatus && (
                    <div class="ash-soul-delete-confirm" aria-labelledby="ash-soul-delete-confirm-title">
                      <div class="ash-soul-delete-confirm-title" id="ash-soul-delete-confirm-title">Delete this identity permanently?</div>
                      <div>This removes only the Soul-owned files:</div>
                      <ul>
                        <li><code>{soulStatus.relativePath}</code></li>
                        <li><code>{`.tachyon/agents/${savedAgent}/profile.json`}</code></li>
                      </ul>
                      <div>The agent directory and every other file inside it will remain.</div>
                      <div class="ash-soul-delete-confirm-actions">
                        <Button ref={deleteCancelButtonRef} onClick={() => setSoulDeleteConfirmOpen(false)}>Cancel</Button>
                        <Button
                          variant="danger"
                          icon="trash"
                          disabled={!canDelete}
                          onClick={() => runSoulAction("Deleting identity", deleteSoulProfileMessage(savedAgent))}
                        >Delete identity permanently</Button>
                      </div>
                    </div>
                  )}

                  <div class="ash-soul-status" role="status" aria-live="polite">
                    {soulBusy
                      ? `${soulBusy}…`
                      : soulStatus
                        ? soulStatus.soulEnabled
                          ? "Soul enabled for future starts"
                          : profilePresent
                            ? "Soul disabled for future starts"
                            : "No Soul identity configured"
                        : "Profile status unavailable. Refresh to try again."}
                  </div>

                  {soulStatus?.transactionDegraded && (
                    <div class="ash-soul-warning" role="alert">Profile recovery is required. Mutating actions are disabled.</div>
                  )}

                  {soulStatus && (
                    <div class="ash-soul-meta">
                      <span>{soulStatus.relativePath}</span>
                      {soulStatus.bytes !== undefined && <span>{soulStatus.bytes} bytes</span>}
                      {soulStatus.sha256 && <span title={soulStatus.sha256}>SHA-256 {soulStatus.sha256.slice(0, 12)}…</span>}
                    </div>
                  )}

                  {soulStatus?.preview !== undefined && (
                    <pre class="ash-soul-preview" aria-label="SOUL.md preview" tabIndex={0}>{soulStatus.preview}</pre>
                  )}
                </>
              ) : (
                <div class="ash-soul-status" role="status">Save this agent before creating or importing its identity profile.</div>
              )}
            </section>

            <div class="ash-grid ash-grid-compact">
              <div class="ash-field">
                <label class="ash-label" for="ash-name">Name</label>
                <Input id="ash-name" value={fields.name} disabled={canonical && mode === "edit"} placeholder="frontend, revisor, dev..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
              </div>

              <div class="ash-field">
                <label class="ash-label" for="ash-role">Role template</label>
                <Select id="ash-role" value={fields.role} onChange={(e) => set("role", (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">(none)</option>
                  <option value="coder">coder</option>
                  <option value="reviewer">reviewer</option>
                  <option value="tester">tester</option>
                  <option value="orchestrator">orchestrator</option>
                  <option value="custom">custom</option>
                </Select>
              </div>
            </div>

            <div class="ash-group">
              <label class="ash-label" for="ash-cmd">Command</label>
              <Input id="ash-cmd" value={fields.cmd} placeholder="claude · codex · agy · npm run dev" onInput={(e) => set("cmd", (e.currentTarget as HTMLInputElement).value)} />
              {!canonical && <div class="ash-chips">
                {flags.map((flag) => (
                  <Chip key={flag} active={fields.cmd.includes(flag)} onClick={() => toggleFlag(flag)}>{flag}</Chip>
                ))}
              </div>}
            </div>

            {!canonical && <details open={!!fields.instructions}>
              <summary>Persistent instructions</summary>
              <Textarea rows={4} value={fields.instructions} placeholder="you are a code reviewer; read the diff and flag correctness issues…" onInput={(e) => set("instructions", (e.currentTarget as HTMLTextAreaElement).value)} />
              <div class="hint">{entity.persistentInstructionsHelp}</div>
            </details>}

            <EvolutionSection
              labels={entity.evolutionLabels}
              savedAgent={savedAgent}
              enabled={fields.selfEvolution}
              toggleDisabled={canonical}
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

            {!canonical && <><div class="checks ash-check-grid">
              <label><input type="checkbox" checked={fields.autostart} onChange={(e) => set("autostart", (e.currentTarget as HTMLInputElement).checked)} /> Auto-start</label>
              <label><input type="checkbox" checked={fields.restartOnCrash} onChange={(e) => set("restartOnCrash", (e.currentTarget as HTMLInputElement).checked)} /> Restart on crash</label>
              <label><input type="checkbox" checked={fields.attention} onChange={(e) => set("attention", (e.currentTarget as HTMLInputElement).checked)} /> Attention detection</label>
            </div>

            <div class="ash-group">
              <label class="ash-label" for="ash-cwd">Working directory</label>
              <div class="ash-row">
                <Input id="ash-cwd" value={fields.cwd} placeholder={`(workspace root: ${entity.defaultCwd})`} onInput={(e) => set("cwd", (e.currentTarget as HTMLInputElement).value)} />
                <Button onClick={() => post(browseMessage())}>Browse</Button>
              </div>
            </div>

            {/* t-a1ba6c — advanced sections live in the main fields column (natural document flow
             * under Working directory). StudioFrame's sideActions slot sits AFTER flex:1 main and
             * was pinning these as a lonely bottom footer with a huge empty void on short forms. */}
            <details open={fields.worktree || !!fields.branch || !!fields.worktreeSetup || !!fields.verify}>
              <summary>Git worktree isolation</summary>
              <label class="check"><input type="checkbox" checked={fields.worktree} onChange={(e) => set("worktree", (e.currentTarget as HTMLInputElement).checked)} /> Run in its own git worktree + branch</label>
              <label class="ash-label" for="ash-branch">Branch (blank = tachyon/&lt;name&gt;)</label>
              <Input id="ash-branch" value={fields.branch} placeholder="feature/auth-redesign" onInput={(e) => set("branch", (e.currentTarget as HTMLInputElement).value)} />
              <label class="ash-label" for="ash-setup">Setup commands (run once on create)</label>
              <Textarea id="ash-setup" rows={3} value={fields.worktreeSetup} onInput={(e) => set("worktreeSetup", (e.currentTarget as HTMLTextAreaElement).value)} />
              <label class="ash-label" for="ash-verify">Verify gate (proves the branch is shippable)</label>
              <Input id="ash-verify" value={fields.verify} placeholder="npm test · cargo test · a command/runbook name" onInput={(e) => set("verify", (e.currentTarget as HTMLInputElement).value)} />
              <div class="ash-chips">
                {entity.verifyCandidates.map((c) => (
                  <Chip key={c} active={c === fields.verify.trim()} onClick={() => set("verify", c)}>{c}</Chip>
                ))}
              </div>
            </details>

            {showHarness && (
              <details open={fields.harness}>
                <summary>Isolated harness</summary>
                <label class="check"><input type="checkbox" checked={fields.harness} onChange={(e) => set("harness", (e.currentTarget as HTMLInputElement).checked)} /> {harnessCheckboxLabel}</label>
                <label class="ash-label" for="ash-inherit">Inherit</label>
                <Select id="ash-inherit" value={fields.harnessInherit} onChange={(e) => set("harnessInherit", (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="workspace">workspace</option>
                  <option value="none">none</option>
                </Select>
                <label class="ash-label" for="ash-mcp">MCP servers (YAML)</label>
                <Textarea id="ash-mcp" rows={6} value={fields.harnessMcp} onInput={(e) => set("harnessMcp", (e.currentTarget as HTMLTextAreaElement).value)} />
                {showHarnessInstructions && (
                  <>
                    <label class="ash-label" for="ash-instructions">Instruction files — one path per line</label>
                    <Textarea id="ash-instructions" rows={2} value={fields.harnessInstructions} onInput={(e) => set("harnessInstructions", (e.currentTarget as HTMLTextAreaElement).value)} />
                  </>
                )}
                {showHarnessRules && (
                  <>
                    <label class="ash-label" for="ash-rules">Rule files — one path per line</label>
                    <Textarea id="ash-rules" rows={2} value={fields.harnessRules} onInput={(e) => set("harnessRules", (e.currentTarget as HTMLTextAreaElement).value)} />
                  </>
                )}
                <label class="ash-label" for="ash-skills">Skill dirs — one path per line</label>
                <Textarea id="ash-skills" rows={2} value={fields.harnessSkills} onInput={(e) => set("harnessSkills", (e.currentTarget as HTMLTextAreaElement).value)} />
                <label class="ash-label" for="ash-hooks">Hooks (YAML)</label>
                <Textarea id="ash-hooks" rows={4} value={fields.harnessHooks} onInput={(e) => set("harnessHooks", (e.currentTarget as HTMLTextAreaElement).value)} />
              </details>
            )}</>}
          </div>
        ),
      }}
    />
  );
}
