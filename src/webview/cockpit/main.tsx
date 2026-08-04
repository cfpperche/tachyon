import { render } from "preact";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ToastProvider, useToast, type ToastTone } from "../shared/ui";
import { App } from "./App";
import {
  INIT,
  MODEL,
  NAV_SLOW_MS,
  NAV_STALL_MS,
  readyMessage,
  refreshAction,
  copyDiagnosticsAction,
  openSettingsAction,
  openDoctorAction,
  setSectionAction,
  switchControlWorkspaceAction,
  revealPathAction,
  copyTextAction,
  openConfigFileAction,
  setCompanionTabToolsAction,
  setIdleAfterMinutesAction,
  setCompanionAllowedHostsAction,
  unpairCompanionDeviceAction,
  issueCompanionPairCodeAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "./messages";
import type { CockpitModel, CockpitSectionId } from "../../cockpit/model";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
// SDD 485 C5 — the Board's envelope and its actions left with its renderer: they belong to
// src/webview/mission-control/main.tsx, the board app's own client, and nothing here speaks them.
import type { StudioDispatch } from "../shared/studio/protocol";
import { dispatchStudioFreezeMessage, isStudioFreezeBusMessage } from "../shared/studio/studioFreezeBus";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (msg: unknown): void => {
  if (vscode) vscode.postMessage(msg);
  else window.postMessage(msg, "*");
};

/** t-0e8a9a — true when the currently-active route is a studio form (owns the nav-transaction freeze
 *  listener; must not be unmounted optimistically on a nav-away — see onSetSection below). Kept as a
 *  local kind-check rather than importing route.ts's `isStudioRoute` to keep main.tsx's import graph
 *  unchanged; the two studio kinds are a closed set. */
const isStudioActiveRoute = (r: CockpitModel["activeRoute"]): boolean =>
  r?.kind === "studio-new" || r?.kind === "studio-edit";

/**
 * SDD 485 — the section ids whose tile/affordance opens a STANDALONE APP rather than navigating Control.
 * Kept client-side and deliberately small: the client only needs to know "do not optimistically render
 * this", never which app it is or where it opens. `Cockpit.ts`'s `navigate()` is what actually routes it.
 */
const STANDALONE_APP_SECTIONS = new Set<CockpitSectionId>(["mission", "tmux", "plugins", "runtime", "inbox"]);

function Root() {
  return (
    <ToastProvider>
      <CockpitRoot />
    </ToastProvider>
  );
}

function CockpitRoot() {
  const toastApi = useToast();
  const [strings, setStrings] = useState<CockpitStrings | undefined>(undefined);
  const [model, setModel] = useState<CockpitModel | undefined>(undefined);
  /** Ephemeral pair offer — not stored in polled model. */
  const [companionPairOffer, setCompanionPairOffer] = useState<CompanionPairOffer | undefined>(undefined);
  const [auto, setAuto] = useState(true);
  /** t-610705 (Phase D, D0) — the studio-envelope + nav-transaction protocols are forwarded raw (no
   *  decode/reshape here — command-studio-shell/App.tsx's own decodeStudioMessage handles it, same
   *  as it did as a standalone panel); `seq` guarantees change detection even across two arrivals
   *  with an identical shape (e.g. two "load" pushes for the same blank new-entity form). */
  const [studioIncoming, setStudioIncoming] = useState<{ seq: number; message: unknown } | undefined>(undefined);
  /**
   * t-ac79a7 — which navigation the host has committed but not finished loading, and how long that
   * has been true. The host brackets every navigation with routePending/routeReady (see Cockpit.ts's
   * `navigate()` and `sendSectionModule()`); this is the client half.
   *
   * Three phases rather than a bare boolean, because "show a spinner the instant a click lands" and
   * "never flash a spinner on a navigation that was instant" are both requirements:
   *  - "pending" lands at 0ms and drives ONLY the actuated element's own pressed/busy styling, which
   *    is the immediate acknowledgement the click needs and costs nothing if the route resolves in
   *    one frame;
   *  - "slow" adds the shell-level progress bar + aria-busy + the polite announcement, after a grace
   *    window, so a fast navigation never flashes chrome at the user;
   *  - "stalled" is the bounded end state — a visible, recoverable banner instead of a spinner that
   *    spins forever when the host never answers (dead engine, stale locator).
   */
  const [navPending, setNavPending] = useState<{ routeKey: string; phase: "pending" | "slow" | "stalled" } | undefined>(undefined);
  const studioSeq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  /**
   * Track companion devices so a successful pair dismisses the ephemeral code card.
   * Fingerprint = sorted device ids (count alone is not enough if a device is replaced in place).
   */
  const companionPairSnapshot = useRef<{ paired: boolean; deviceKey: string } | null>(null);
  // t-610705 (Phase C.2) — the onMsg listener below is mounted once ([] deps), so it can't read fresh
  // `model` state directly (stale closure); this ref is kept current from the MODEL branch for the
  // identity checks the ACTIVITY branch makes.
  // SDD 485 C4/C5 — there is no TASK_ERROR branch left at all: "taskError" was the same wire string for
  // the board and the task detail, and both took their protocol with them when they became their own apps.
  // Control now speaks neither, which is a stronger statement than disambiguating them correctly.
  const activeRouteRef = useRef<CockpitModel["activeRoute"]>(undefined);
  // t-610705 (Phase D, D1a code-review finding) — `studioIncoming` is ONE shared state slot every
  // studio App reads via its `incoming` prop; a fresh studio component mount does NOT clear it (only
  // a NEW message does), so a stale `incoming` from the PREVIOUS studio binding is what a just-
  // mounted DIFFERENT studio's component sees on its first render — decodeStudioMessage only checks
  // `type`/`studioProtocolVersion`, not the studio-specific field shape, so a cross-studio residue
  // (e.g. Schedule's `load` envelope reaching a freshly-mounted Terminal component) is accepted as if
  // it were Terminal's own load and can crash on a field the two studios don't share (e.g. Terminal's
  // `firstToken(fields.cmd)` against Schedule's fields, which have no `cmd`). Tracked here (not in an
  // effect on the studio App side) because the fix must land BEFORE the new component's first render
  // — an effect that clears `studioIncoming` only runs AFTER that render already used the stale
  // value. Comparing `studioMountNonce` catches every rebind (cross-studio AND same-studio-different-
  // entity), same "identity" concept `ensureStudioBinding`/`useEffect([routeKey, mountNonce])` uses.
  //
  // A round-2 review pass asked whether a message legitimately posted for the OLD binding could
  // still arrive at the client AFTER this clear runs (this ref only clears what's ALREADY stored at
  // transition time — it has no way to reject a late arrival, since host->client studio-envelope
  // messages carry no routeKey/mountNonce, unlike client->host ones since round-5). Verified against
  // studioHost.ts/Cockpit.ts directly (not just reasoned about): `navigate()` — called SYNCHRONOUSLY
  // by every commit path (`beginStudioNavTransaction`'s `commit`) BEFORE `sendModel()`/`ensureStudio-
  // Binding` ever run for the NEW binding — tears the OLD binding down first via
  // `reconcileStudioTeardown` (`binding = undefined`). Every host-side post path for the old binding
  // (`sendStudioLoad`, `refreshStudioReferenceData`, `beginStudioSave`, `beginStudioNavTransaction`'s
  // own checkpoint/save flow) re-checks `binding !== b` (the captured old binding) immediately before
  // every `io.post(...)` — since `binding` is ALREADY torn down (or reassigned to the new one) before
  // `sendModel()`'s own internal `await deps.collect()` gap even opens, there is no window where the
  // OLD binding's async continuation can find `binding === b` and legitimately post AFTER the new
  // binding's own "model" push. This is the same generation/`binding !== b` invariant D0's own 6
  // review rounds already hardened for every host post path — this ref's job is only the CLIENT-side
  // half (drop a residue the host correctly never re-sends), not a second independent proof of it.
  const studioMountNonceRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const raw = e.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      const type = raw.type;

      if (type === "routePending" && typeof raw.routeKey === "string") {
        // Unconditional: a NEW navigation always supersedes an in-flight one (clicking a second
        // Board card while the first is still loading must track the second, not be swallowed as a
        // duplicate). Same-key re-entry simply re-arms the same pending state, which is why a double
        // click on ONE card is a no-op instead of a second spinner — dedupe falls out of keying by
        // route identity rather than needing a separate click guard that could block real navigation.
        const routeKey = raw.routeKey;
        setNavPending((prev) => (prev?.routeKey === routeKey ? prev : { routeKey, phase: "pending" }));
      }
      else if (type === "routeReady" && typeof raw.routeKey === "string") {
        // Only the pending route's OWN ready clears it. A superseded route finishing late must not
        // clear the newer navigation's pending state (the host already drops most of those via its
        // epoch guard; matching here means the client doesn't depend on that alone).
        const routeKey = raw.routeKey;
        setNavPending((prev) => (prev && prev.routeKey !== routeKey ? prev : undefined));
      }
      else if (type === INIT && raw.strings) setStrings(raw.strings as CockpitStrings);
      else if (type === MODEL && raw.model) {
        const next = raw.model as CockpitModel;
        const paired = next.companion?.paired === true;
        const deviceKey = (next.companion?.devices ?? [])
          .map((d) => d.id)
          .filter(Boolean)
          .slice()
          .sort()
          .join("|");
        const prev = companionPairSnapshot.current;
        // Dismiss offer when pairing lands: not-paired→paired, or connected-device set changes
        // (new/replaced device). Unpair also clears a stale offer. Fresh "Show pair code" while
        // already paired still shows until the next device change.
        if (prev && ((!prev.paired && paired) || prev.deviceKey !== deviceKey)) {
          setCompanionPairOffer(undefined);
        }
        companionPairSnapshot.current = { paired, deviceKey };
        activeRouteRef.current = next.activeRoute;
        if (next.studioMountNonce !== studioMountNonceRef.current) {
          studioMountNonceRef.current = next.studioMountNonce;
          setStudioIncoming(undefined);
        }
        setModel(next);
      }
      // SDD 485 D4 — the four Human Inbox arms left with the renderer: the Inbox is a standalone
      // `dashboard` app, and its client half is `human-inbox/main.tsx`, which owns its state slots, its
      // own 3s poll, and the list/item subroute the HOST decides. The identity checks these two arms
      // made went with them for C4's reason: they existed because ONE panel served every route, and a
      // panel that IS one project's queue has no second identity for a late push to belong to.
      // SDD 485 D3 — the two runtime-ops arms left with the renderer: Runtime Ops is a standalone app, and
      // its client half is `runtime-ops/main.tsx`, which owns both state slots and its own 3s poll.
      else if (type === "toast" && typeof raw.text === "string") {
        const toneRaw = typeof raw.tone === "string" ? raw.tone : "info";
        const tone: ToastTone =
          toneRaw === "ok" || toneRaw === "warn" || toneRaw === "err" || toneRaw === "info"
            ? toneRaw
            : "info";
        toastApi.show({
          message: raw.text,
          tone,
          ...(typeof raw.context === "string" && raw.context ? { context: raw.context } : {}),
        });
      } else if (type === "companionPairOffer" && raw.offer && typeof raw.offer === "object") {
        setCompanionPairOffer(raw.offer as CompanionPairOffer);
      } else if (isStudioFreezeBusMessage(raw)) {
        // t-610705 (Phase D, D0, round-3 blocker #3) — dispatched SYNCHRONOUSLY, not through React
        // state, so the mounted studio App's freeze can take effect before any subsequently-queued
        // input event is processed — see studioFreezeBus.ts's module doc for why this can't go
        // through the same setState+useEffect path as everything else in this listener.
        dispatchStudioFreezeMessage(raw);
      } else if (typeof raw.studioProtocolVersion === "number") {
        // t-610705 (Phase D, D0) — studio-envelope core/domain messages (load/error/restore/cwd/
        // save) forward here unmodified; the mounted studio App's own decodeStudioMessage sorts out
        // which is which.
        studioSeq.current += 1;
        setStudioIncoming({ seq: studioSeq.current, message: raw });
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => {
      window.removeEventListener("message", onMsg);
    };
  }, [toastApi]);

  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = undefined;
    }
    if (auto && strings) timer.current = window.setInterval(() => post(refreshAction()), 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto, strings]);

  /**
   * t-ac79a7 — escalate a pending navigation through its two thresholds. Keyed on the routeKey, so a
   * navigation that supersedes another restarts the clock rather than inheriting the old one's age.
   *
   * NAV_SLOW_MS is a grace window, not a delay: the actuated element is already showing "pending" at
   * 0ms, and this only decides when the SHELL escalates to a progress bar. Below it, a navigation
   * that resolves quickly never flashes chrome.
   * NAV_STALL_MS is the bound that makes "never an infinite spinner" true rather than intended — when
   * it fires the UI switches to a recoverable banner with a retry, not more spinning.
   */
  useEffect(() => {
    if (!navPending || navPending.phase === "stalled") return;
    const key = navPending.routeKey;
    const toSlow = window.setTimeout(
      () => setNavPending((p) => (p?.routeKey === key && p.phase === "pending" ? { ...p, phase: "slow" } : p)),
      NAV_SLOW_MS,
    );
    const toStalled = window.setTimeout(
      () => setNavPending((p) => (p?.routeKey === key && p.phase !== "stalled" ? { ...p, phase: "stalled" } : p)),
      NAV_STALL_MS,
    );
    return () => {
      clearTimeout(toSlow);
      clearTimeout(toStalled);
    };
  }, [navPending?.routeKey, navPending?.phase]);


  // t-610705 (Phase D, D0/D1a) — {post} is the whole contract (StudioDispatch); every studio App
  // posts fully-formed enveloped messages itself (readyMessage/patchMessage/etc.), same as it did as
  // a standalone panel. ONE shared dispatch for every StudioId (D1a — was command-specific) since
  // only one studio binding is ever active at a time.
  const studioDispatch: StudioDispatch = useMemo(() => ({ post }), []);

  // SDD 485 D2 — `pluginsDispatch` left with the renderer: Plugins is a standalone app, and its client
  // half is `plugins/main.tsx`, which owns this dispatch, its own ToastProvider and its own 3s poll.

  return (
    <App
      model={model}
      strings={strings}
      navPending={navPending}
      // t-ac79a7 — the stalled banner's escape hatch. Reuses the existing `refresh` action rather
      // than inventing a retry message: refresh re-runs sendModel + sendSectionModule for the
      // current route, which is exactly a retry, and its completion posts the routeReady that
      // clears this state.
      onRetryNavigation={() => {
        setNavPending((p) => (p ? { ...p, phase: "slow" } : p));
        post(refreshAction());
      }}
      auto={auto}
      onToggleAuto={setAuto}
      onRefresh={() => post(refreshAction())}
      onCopyDiagnostics={() => post(copyDiagnosticsAction())}
      onOpenSettings={() => post(openSettingsAction())}
      onOpenDoctor={() => post(openDoctorAction())}
      onRevealPath={(path) => post(revealPathAction(path))}
      onCopyText={(text) => post(copyTextAction(text))}
      onOpenConfigFile={(wsHash) => post(openConfigFileAction(wsHash))}
      onSetCompanionTabTools={(wsHash, enabled) => post(setCompanionTabToolsAction(wsHash, enabled))}
      onSetIdleAfterMinutes={(wsHash, minutes) => post(setIdleAfterMinutesAction(wsHash, minutes))}
      onSetCompanionAllowedHosts={(wsHash, hosts) => post(setCompanionAllowedHostsAction(wsHash, hosts))}
      onUnpairCompanionDevice={(wsHash, deviceId) => post(unpairCompanionDeviceAction(wsHash, deviceId))}
      onIssueCompanionPairCode={(wsHash) => post(issueCompanionPairCodeAction(wsHash))}
      companionPairOffer={companionPairOffer}
      onPost={(action) => post(action)}
      studioIncoming={studioIncoming}
      studioDispatch={studioDispatch}
      onSetSection={(section: CockpitSectionId) => {
        // SDD 485 C5/D1 — "go to the Board" and "go to tmux" are no longer navigations inside Control: the
        // host answers each by opening that APP and landing Control on Overview. Posted WITHOUT the
        // optimistic model update below on purpose — optimistically rendering a section this build has no
        // renderer for would flash the unknown-section fallback for the frame before the host's real model
        // arrives. A set rather than a chain of `||` because Phase D adds eight more ids to it.
        if (STANDALONE_APP_SECTIONS.has(section)) {
          post(setSectionAction(section));
          return;
        }
        // t-610705 (Phase C.1) — a plain setSection always lands on that section's own top-level
        // route (never a subroute), so any activeRoute left over from a prior subroute visit
        // must clear optimistically too — the App's render switch checks activeRoute BEFORE
        // section, so a stale subroute would otherwise flash until the host's real reply.
        //
        // t-0e8a9a EXCEPTION — but NOT when leaving a STUDIO route: a studio owns the nav-transaction
        // freeze listener (useStudioFreeze), and the host answers a nav-away by posting
        // studioNavCheckpoint that ONLY the mounted studio can ack. Clearing activeRoute here unmounts
        // the studio synchronously → its freeze listener tears down → the checkpoint is dropped → the
        // host's 3s timeout aborts the navigation → the 3s poll re-asserts the studio route → the user
        // is trapped, unable to leave the studio at all (found in 0.56.91 dogfood; affects every
        // studio whose breadcrumb targets a section — command/terminal/runbook/schedule/agent). For a
        // studio route we leave activeRoute in place and let the HOST drive the transition: it either
        // commits the nav (and pushes a clean model that clears activeRoute) or aborts (keeping the
        // studio). No optimistic flash to avoid here anyway — the studio stays put until the
        // checkpoint resolves, which is the correct UX.
        const leavingStudio = isStudioActiveRoute(activeRouteRef.current);
        if (leavingStudio) {
          setModel((prev) => (prev ? { ...prev, section } : prev));
        } else {
          setModel((prev) => (prev ? { ...prev, section, activeRoute: undefined } : prev));
          activeRouteRef.current = undefined;
        }
        // t-610705 (Phase C.2) — same optimistic-clear reasoning as activeRoute above, for the
        // feed-identity state the MODEL branch's reset otherwise only clears on the host's next reply.
        post(setSectionAction(section));
      }}
      onSwitchWorkspace={(wsHash: string) => {
        // t-d16a39 — optimistic model update (selector reflects the choice instantly); the host
        // re-sends the authoritative scoped model + the active section's module right after.
        setModel((prev) => (prev ? { ...prev, selectedWsHash: wsHash || undefined } : prev));
        setCompanionPairOffer(undefined);
        post(switchControlWorkspaceAction(wsHash));
      }}
    />
  );
}

const root = document.getElementById("root");
// t-668b05 — the ONE catch-all safety net: an uncaught render exception anywhere in Root's tree
// (any embedded surface, any route) now degrades to a visible error instead of a blank/black panel.
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
